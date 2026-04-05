import { describe, it, expect } from "vitest";
import {
  inspectChanges,
  FileChange,
  ChangeSummary,
  parseGraphQLDefinitions,
  diffGraphQL,
  diffConfig,
  flattenObject,
  diffArrayElements,
  diffOpenAPI,
  parseGraphQLFields,
  diffGraphQLFields,
} from "../src/diff-inspector";
import { SyncRule } from "../src/config";

const makeRule = (
  glob: string,
  fileTypes: string[],
  pageId = "page1",
  hint = "Test Section"
): SyncRule => ({
  match: { path_glob: glob, file_types: fileTypes },
  doc: { notion_page_id: pageId, section_hint: hint },
});

describe("diff-inspector: OpenAPI changes", () => {
  it("detects added endpoints", () => {
    const before = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/users": {
          get: { summary: "List users", responses: { "200": {} } },
        },
      },
    });

    const after = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/users": {
          get: { summary: "List users", responses: { "200": {} } },
          post: {
            summary: "Create user",
            parameters: [{ name: "body", in: "body" }],
            responses: { "201": {} },
          },
        },
      },
    });

    const files: FileChange[] = [
      {
        filename: "services/payments/openapi.yaml",
        status: "modified",
        beforeContent: before,
        afterContent: after,
      },
    ];

    const rules = [makeRule("services/payments/**", ["openapi"])];
    const results = inspectChanges(files, rules);

    expect(results).toHaveLength(1);
    expect(results[0].endpoints).toHaveLength(1);
    expect(results[0].endpoints[0].changeType).toBe("added");
    expect(results[0].endpoints[0].method).toBe("POST");
    expect(results[0].endpoints[0].path).toBe("/users");
  });

  it("detects removed endpoints", () => {
    const before = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/users": {
          get: { summary: "List" },
          delete: { summary: "Delete all" },
        },
      },
    });

    const after = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/users": {
          get: { summary: "List" },
        },
      },
    });

    const files: FileChange[] = [
      {
        filename: "services/payments/api.json",
        status: "modified",
        beforeContent: before,
        afterContent: after,
      },
    ];

    const results = inspectChanges(
      files,
      [makeRule("services/payments/**", ["openapi"])]
    );
    expect(results[0].endpoints).toHaveLength(1);
    expect(results[0].endpoints[0].changeType).toBe("removed");
    expect(results[0].endpoints[0].method).toBe("DELETE");
  });

  it("detects modified endpoints", () => {
    const before = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/users": {
          get: {
            summary: "List users",
            parameters: [{ name: "limit", in: "query" }],
          },
        },
      },
    });

    const after = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/users": {
          get: {
            summary: "List users",
            parameters: [
              { name: "limit", in: "query" },
              { name: "offset", in: "query" },
            ],
          },
        },
      },
    });

    const files: FileChange[] = [
      {
        filename: "services/payments/api.yaml",
        status: "modified",
        beforeContent: before,
        afterContent: after,
      },
    ];

    const results = inspectChanges(
      files,
      [makeRule("services/payments/**", ["openapi"])]
    );
    expect(results[0].endpoints).toHaveLength(1);
    expect(results[0].endpoints[0].changeType).toBe("modified");
    expect(results[0].endpoints[0].details).toContain("offset");
  });

  it("handles complex OpenAPI with nested schemas", () => {
    const before = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/orders": {
          get: {
            summary: "List orders",
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { "$ref": "#/components/schemas/Order" },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const after = JSON.stringify({
      openapi: "3.0.0",
      paths: {
        "/orders": {
          get: {
            summary: "List orders",
            parameters: [{ name: "status", in: "query" }],
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "array",
                      items: { "$ref": "#/components/schemas/Order" },
                    },
                  },
                },
              },
              "400": {
                description: "Bad request",
              },
            },
          },
          post: {
            summary: "Create order",
            requestBody: {
              content: {
                "application/json": {
                  schema: { "$ref": "#/components/schemas/CreateOrder" },
                },
              },
            },
            responses: { "201": {} },
          },
        },
      },
    });

    const files: FileChange[] = [
      {
        filename: "services/payments/openapi.yaml",
        status: "modified",
        beforeContent: before,
        afterContent: after,
      },
    ];

    const results = inspectChanges(files, [makeRule("services/payments/**", ["openapi"])]);
    expect(results).toHaveLength(1);
    expect(results[0].endpoints.length).toBeGreaterThanOrEqual(2);

    const addedPost = results[0].endpoints.find(
      (e) => e.method === "POST" && e.changeType === "added"
    );
    expect(addedPost).toBeDefined();

    const modifiedGet = results[0].endpoints.find(
      (e) => e.method === "GET" && e.changeType === "modified"
    );
    expect(modifiedGet).toBeDefined();
    expect(modifiedGet!.details).toContain("status");
  });
});

describe("diff-inspector: GraphQL changes", () => {
  it("detects added types", () => {
    const before = `
type Query {
  users: [User]
}

type User {
  id: ID!
  name: String
}
`;
    const after = `
type Query {
  users: [User]
  payments: [Payment]
}

type User {
  id: ID!
  name: String
}

type Payment {
  id: ID!
  amount: Float
  currency: String
}
`;

    const files: FileChange[] = [
      {
        filename: "services/payments/schema.graphql",
        status: "modified",
        beforeContent: before,
        afterContent: after,
      },
    ];

    const results = inspectChanges(
      files,
      [makeRule("services/payments/**", ["graphql"])]
    );

    expect(results).toHaveLength(1);
    const gqlChanges = results[0].graphqlChanges;
    expect(gqlChanges.length).toBeGreaterThanOrEqual(1);

    const paymentType = gqlChanges.find((c) => c.name === "Payment");
    expect(paymentType).toBeDefined();
    expect(paymentType?.changeType).toBe("added");

    const queryMod = gqlChanges.find((c) => c.name === "Query");
    expect(queryMod).toBeDefined();
    expect(queryMod?.changeType).toBe("modified");
  });

  it("detects removed types", () => {
    const before = `
type Query {
  users: [User]
}

type User {
  id: ID!
}

type Legacy {
  old: String
}
`;
    const after = `
type Query {
  users: [User]
}

type User {
  id: ID!
}
`;

    const files: FileChange[] = [
      {
        filename: "services/payments/schema.graphql",
        status: "modified",
        beforeContent: before,
        afterContent: after,
      },
    ];

    const results = inspectChanges(
      files,
      [makeRule("services/payments/**", ["graphql"])]
    );
    const removed = results[0].graphqlChanges.find(
      (c) => c.name === "Legacy"
    );
    expect(removed).toBeDefined();
    expect(removed?.changeType).toBe("removed");
  });

  it("detects Query and Mutation root definitions", () => {
    const before = `
type Query {
  users: [User]
}

type Mutation {
  createUser(name: String!): User
}
`;
    const after = `
type Query {
  users: [User]
  user(id: ID!): User
}

type Mutation {
  createUser(name: String!): User
  deleteUser(id: ID!): Boolean
}
`;
    const changes = diffGraphQL(before, after);

    const queryChange = changes.find((c) => c.name === "Query");
    expect(queryChange).toBeDefined();
    expect(queryChange?.changeType).toBe("modified");
    expect(queryChange?.fieldChanges?.some((f) => f.fieldName === "user" && f.changeType === "added")).toBe(true);

    const mutationChange = changes.find((c) => c.name === "Mutation");
    expect(mutationChange).toBeDefined();
    expect(mutationChange?.changeType).toBe("modified");
    expect(mutationChange?.fieldChanges?.some((f) => f.fieldName === "deleteUser" && f.changeType === "added")).toBe(true);
  });

  it("detects extend type definitions", () => {
    const before = `
type User {
  id: ID!
  name: String
}
`;
    const after = `
type User {
  id: ID!
  name: String
}

extend type User {
  email: String
}
`;
    const changes = diffGraphQL(before, after);
    const extendChange = changes.find(
      (c) => c.name === "User" && c.changeType === "added"
    );
    expect(extendChange).toBeDefined();
  });

  it("detects interface definitions", () => {
    const before = `
type Query {
  nodes: [Node]
}
`;
    const after = `
type Query {
  nodes: [Node]
}

interface Node {
  id: ID!
  createdAt: DateTime
}
`;
    const changes = diffGraphQL(before, after);
    const interfaceChange = changes.find(
      (c) => c.name === "Node" && c.kind === "interface"
    );
    expect(interfaceChange).toBeDefined();
    expect(interfaceChange?.changeType).toBe("added");
  });

  it("detects directive definitions", () => {
    const before = "";
    const after = `
directive @auth on FIELD_DEFINITION | OBJECT
`;
    const changes = diffGraphQL(before, after);
    const directiveChange = changes.find(
      (c) => c.name === "auth" && c.kind === "directive"
    );
    expect(directiveChange).toBeDefined();
    expect(directiveChange?.changeType).toBe("added");
  });

  it("provides field-level granularity on modified types", () => {
    const before = `
type User {
  id: ID!
  name: String
  email: String
}
`;
    const after = `
type User {
  id: ID!
  name: String!
  avatar: String
}
`;
    const changes = diffGraphQL(before, after);
    const userChange = changes.find((c) => c.name === "User");
    expect(userChange).toBeDefined();
    expect(userChange?.changeType).toBe("modified");
    expect(userChange?.fieldChanges).toBeDefined();

    const fieldChanges = userChange!.fieldChanges!;
    expect(fieldChanges.some((f) => f.fieldName === "avatar" && f.changeType === "added")).toBe(true);
    expect(fieldChanges.some((f) => f.fieldName === "email" && f.changeType === "removed")).toBe(true);
    expect(fieldChanges.some((f) => f.fieldName === "name" && f.changeType === "modified")).toBe(true);
  });

  it("handles schema block definitions", () => {
    const before = "";
    const after = `
schema {
  query: Query
  mutation: Mutation
}
`;
    const changes = diffGraphQL(before, after);
    const schemaChange = changes.find((c) => c.kind === "schema");
    expect(schemaChange).toBeDefined();
    expect(schemaChange?.changeType).toBe("added");
  });
});

describe("diff-inspector: Config changes", () => {
  it("detects added keys", () => {
    const before = JSON.stringify({ database: { host: "localhost" } });
    const after = JSON.stringify({
      database: { host: "localhost", port: 5432 },
    });

    const files: FileChange[] = [
      {
        filename: "config/settings.json",
        status: "modified",
        beforeContent: before,
        afterContent: after,
      },
    ];

    const results = inspectChanges(
      files,
      [makeRule("config/**", ["json"])]
    );
    expect(results).toHaveLength(1);
    const added = results[0].configChanges.find(
      (c) => c.key === "database.port"
    );
    expect(added).toBeDefined();
    expect(added?.changeType).toBe("added");
    expect(added?.newValue).toBe("5432");
  });

  it("detects removed keys", () => {
    const before = JSON.stringify({ a: 1, b: 2 });
    const after = JSON.stringify({ a: 1 });

    const files: FileChange[] = [
      {
        filename: "config/app.json",
        status: "modified",
        beforeContent: before,
        afterContent: after,
      },
    ];

    const results = inspectChanges(
      files,
      [makeRule("config/**", ["json"])]
    );
    const removed = results[0].configChanges.find((c) => c.key === "b");
    expect(removed).toBeDefined();
    expect(removed?.changeType).toBe("removed");
  });

  it("detects modified values", () => {
    const before = `
server:
  port: 3000
  host: localhost
`;
    const after = `
server:
  port: 8080
  host: localhost
`;

    const files: FileChange[] = [
      {
        filename: "config/server.yaml",
        status: "modified",
        beforeContent: before,
        afterContent: after,
      },
    ];

    const results = inspectChanges(
      files,
      [makeRule("config/**", ["yaml"])]
    );
    const modified = results[0].configChanges.find(
      (c) => c.key === "server.port"
    );
    expect(modified).toBeDefined();
    expect(modified?.changeType).toBe("modified");
    expect(modified?.oldValue).toBe("3000");
    expect(modified?.newValue).toBe("8080");
  });

  it("diffs arrays element-by-element", () => {
    const before = JSON.stringify({
      features: ["auth", "payments", "notifications"],
    });
    const after = JSON.stringify({
      features: ["auth", "payments", "analytics"],
    });

    const changes = diffConfig(before, after);
    // Should detect element-level changes
    const removedItem = changes.find(
      (c) => c.changeType === "removed" && c.oldValue === "notifications"
    );
    const addedItem = changes.find(
      (c) => c.changeType === "added" && c.newValue === "analytics"
    );
    expect(removedItem).toBeDefined();
    expect(addedItem).toBeDefined();
  });

  it("diffs arrays of objects by index", () => {
    const before = JSON.stringify({
      servers: [
        { host: "prod1.example.com", port: 443 },
        { host: "prod2.example.com", port: 443 },
      ],
    });
    const after = JSON.stringify({
      servers: [
        { host: "prod1.example.com", port: 443 },
        { host: "prod2.example.com", port: 8443 },
      ],
    });

    const changes = diffConfig(before, after);
    const portChange = changes.find(
      (c) => c.key === "servers[1].port" && c.changeType === "modified"
    );
    expect(portChange).toBeDefined();
    expect(portChange?.oldValue).toBe("443");
    expect(portChange?.newValue).toBe("8443");
  });

  it("handles empty file content gracefully", () => {
    const changes = diffConfig("", "");
    expect(changes).toHaveLength(0);
  });

  it("handles null parsed content", () => {
    const changes = diffConfig("not-valid-yaml: [", undefined);
    expect(Array.isArray(changes)).toBe(true);
  });
});

describe("diff-inspector: file matching", () => {
  it("only matches files within the glob pattern", () => {
    const files: FileChange[] = [
      {
        filename: "services/payments/api.yaml",
        status: "modified",
        beforeContent: '{"openapi":"3.0.0","paths":{}}',
        afterContent: '{"openapi":"3.0.0","paths":{"/new":{"get":{}}}}',
      },
      {
        filename: "services/auth/api.yaml",
        status: "modified",
        beforeContent: '{"openapi":"3.0.0","paths":{}}',
        afterContent: '{"openapi":"3.0.0","paths":{"/login":{"post":{}}}}',
      },
    ];

    const rules = [makeRule("services/payments/**", ["openapi"])];
    const results = inspectChanges(files, rules);

    expect(results).toHaveLength(1);
    expect(results[0].matchedFiles).toEqual(["services/payments/api.yaml"]);
  });

  it("returns empty when no files match", () => {
    const files: FileChange[] = [
      {
        filename: "unrelated/file.txt",
        status: "modified",
      },
    ];

    const results = inspectChanges(
      files,
      [makeRule("services/**", ["openapi"])]
    );
    expect(results).toHaveLength(0);
  });

  it("handles new files (added status)", () => {
    const after = JSON.stringify({
      openapi: "3.0.0",
      paths: { "/health": { get: { summary: "Health check" } } },
    });

    const files: FileChange[] = [
      {
        filename: "services/payments/openapi.json",
        status: "added",
        afterContent: after,
      },
    ];

    const results = inspectChanges(
      files,
      [makeRule("services/payments/**", ["openapi"])]
    );
    expect(results).toHaveLength(1);
    expect(results[0].endpoints).toHaveLength(1);
    expect(results[0].endpoints[0].changeType).toBe("added");
  });

  it("handles binary / unknown file types", () => {
    const files: FileChange[] = [
      {
        filename: "services/payments/image.png",
        status: "modified",
      },
    ];
    const results = inspectChanges(files, [makeRule("services/payments/**", ["openapi"])]);
    expect(results).toHaveLength(0);
  });

  it("handles empty file content", () => {
    const files: FileChange[] = [
      {
        filename: "config/empty.yaml",
        status: "modified",
        beforeContent: "",
        afterContent: "",
      },
    ];
    const results = inspectChanges(files, [makeRule("config/**", ["yaml"])]);
    // Should match but produce no changes
    expect(results).toHaveLength(1);
    expect(results[0].configChanges).toHaveLength(0);
  });
});

describe("flattenObject", () => {
  it("flattens nested objects", () => {
    const flat = flattenObject({ a: { b: { c: 1 } } });
    expect(flat.get("a.b.c")).toBe("1");
  });

  it("flattens arrays element-by-element", () => {
    const flat = flattenObject({ tags: ["a", "b", "c"] });
    expect(flat.get("tags[0]")).toBe("a");
    expect(flat.get("tags[1]")).toBe("b");
    expect(flat.get("tags[2]")).toBe("c");
  });

  it("flattens arrays of objects", () => {
    const flat = flattenObject({ items: [{ x: 1 }, { x: 2 }] });
    expect(flat.get("items[0].x")).toBe("1");
    expect(flat.get("items[1].x")).toBe("2");
  });

  it("handles primitive root", () => {
    const flat = flattenObject(42);
    expect(flat.get("(root)")).toBe("42");
  });
});

describe("parseGraphQLFields", () => {
  it("extracts field names from a type body", () => {
    const body = `id: ID!\n  name: String\n  email: String!`;
    const fields = parseGraphQLFields(body);
    expect(fields.map((f) => f.name)).toEqual(["id", "name", "email"]);
  });

  it("ignores comments", () => {
    const body = `# This is a comment\nid: ID!\nname: String`;
    const fields = parseGraphQLFields(body);
    expect(fields.map((f) => f.name)).toEqual(["id", "name"]);
  });
});

describe("diffGraphQLFields", () => {
  it("detects added, removed, and modified fields", () => {
    const before = [
      { name: "id", definition: "id: ID!" },
      { name: "name", definition: "name: String" },
      { name: "email", definition: "email: String" },
    ];
    const after = [
      { name: "id", definition: "id: ID!" },
      { name: "name", definition: "name: String!" },
      { name: "avatar", definition: "avatar: String" },
    ];

    const changes = diffGraphQLFields(before, after);
    expect(changes.find((c) => c.fieldName === "avatar" && c.changeType === "added")).toBeDefined();
    expect(changes.find((c) => c.fieldName === "email" && c.changeType === "removed")).toBeDefined();
    expect(changes.find((c) => c.fieldName === "name" && c.changeType === "modified")).toBeDefined();
    expect(changes.find((c) => c.fieldName === "id")).toBeUndefined();
  });
});

describe("diffArrayElements", () => {
  it("detects added and removed elements", () => {
    const result = diffArrayElements(["a", "b", "c"], ["a", "c", "d"]);
    expect(result.added).toEqual(["d"]);
    expect(result.removed).toEqual(["b"]);
  });

  it("handles empty arrays", () => {
    const result = diffArrayElements([], ["x"]);
    expect(result.added).toEqual(["x"]);
    expect(result.removed).toEqual([]);
  });
});
