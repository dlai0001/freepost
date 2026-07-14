/**
 * Generate fixtures/collection/* from the real writeRequestFile(), so every
 * fixture request file is byte-for-byte canonical (the same text the app would
 * write). Run: node fixtures/gen-collection.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeRequestFile } from '../src/core/format/writer.ts'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'collection')
mkdirSync(out, { recursive: true })

const files = {
  // ---- MCP (the new kind) ----
  'MCP http - list tools.mcp': {
    kind: 'mcp',
    frontmatter: {
      description: 'Introspect the HTTP MCP fixture: what tools does it expose?',
      label: ['mcp', 'introspection'],
      scripts: {
        test: `pm.test("exposes get-sum", () => {
  const names = pm.response.json().tools.map((t) => t.name);
  pm.expect(names).to.include("get-sum");
});`
      }
    },
    variables: [{ name: 'MCP_URL', defaultValue: 'http://localhost:3011/mcp', required: false }],
    mcp: {
      transport: 'http',
      url: '${MCP_URL}',
      args: [],
      env: [],
      headers: [],
      method: 'tools/list',
      toolArgs: [],
      promptArgs: []
    },
    comments: []
  },

  'MCP http - call get-sum.mcp': {
    kind: 'mcp',
    frontmatter: {
      description: 'Call a tool and ASSERT on the result — the thing Postman cannot do.',
      label: ['mcp'],
      scripts: {
        test: `pm.test("sums 20 + 22", () => {
  pm.expect(pm.response.json().content[0].text).to.contain("42");
});
pm.test("is not a tool error", () => {
  pm.expect(pm.response.json().isError).to.not.equal(true);
});`
      }
    },
    variables: [{ name: 'MCP_URL', defaultValue: 'http://localhost:3011/mcp', required: false }],
    mcp: {
      transport: 'http',
      url: '${MCP_URL}',
      args: [],
      env: [],
      headers: [],
      method: 'tools/call',
      toolName: 'get-sum',
      toolArgs: [
        { name: 'a', value: '20' },
        { name: 'b', value: '22' }
      ],
      promptArgs: []
    },
    comments: []
  },

  'MCP http - tool error (isError).mcp': {
    kind: 'mcp',
    frontmatter: {
      description: "The TOOL failure axis: the call succeeds, the tool reports failure. Not a protocol error.",
      label: ['mcp'],
      scripts: {
        test: `pm.test("reports a tool-level failure", () => {
  pm.expect(pm.response.json().isError).to.equal(true);
});`
      }
    },
    variables: [{ name: 'MCP_URL', defaultValue: 'http://localhost:3011/mcp', required: false }],
    mcp: {
      transport: 'http',
      url: '${MCP_URL}',
      args: [],
      env: [],
      headers: [],
      method: 'tools/call',
      toolName: 'boom',
      toolArgs: [],
      promptArgs: []
    },
    comments: []
  },

  'MCP http - structured output.mcp': {
    kind: 'mcp',
    frontmatter: {
      description: 'A tool with an outputSchema: assert on structuredContent.',
      label: ['mcp'],
      scripts: {
        test: `pm.test("returns structured content", () => {
  const s = pm.response.json().structuredContent;
  pm.expect(s.city).to.equal("Oakland");
  pm.expect(s.tempC).to.be.a("number");
});`
      }
    },
    variables: [{ name: 'MCP_URL', defaultValue: 'http://localhost:3011/mcp', required: false }],
    mcp: {
      transport: 'http',
      url: '${MCP_URL}',
      args: [],
      env: [],
      headers: [],
      method: 'tools/call',
      toolName: 'weather',
      toolArgs: [{ name: 'city', value: 'Oakland' }],
      promptArgs: []
    },
    comments: []
  },

  'MCP http - read resource.mcp': {
    kind: 'mcp',
    frontmatter: {
      description: 'Read an MCP resource by URI.',
      label: ['mcp'],
      scripts: {
        test: `pm.test("reads the greeting", () => {
  pm.expect(pm.response.json().contents[0].text).to.contain("freepost");
});`
      }
    },
    variables: [{ name: 'MCP_URL', defaultValue: 'http://localhost:3011/mcp', required: false }],
    mcp: {
      transport: 'http',
      url: '${MCP_URL}',
      args: [],
      env: [],
      headers: [],
      method: 'resources/read',
      toolArgs: [],
      uri: 'demo://greeting',
      promptArgs: []
    },
    comments: []
  },

  'MCP http - get prompt.mcp': {
    kind: 'mcp',
    frontmatter: {
      description: 'Render a parameterised prompt template.',
      label: ['mcp'],
      scripts: {
        test: `pm.test("greets Ada", () => {
  pm.expect(pm.response.json().messages[0].content.text).to.contain("Ada");
});`
      }
    },
    variables: [{ name: 'MCP_URL', defaultValue: 'http://localhost:3011/mcp', required: false }],
    mcp: {
      transport: 'http',
      url: '${MCP_URL}',
      args: [],
      env: [],
      headers: [],
      method: 'prompts/get',
      toolArgs: [],
      promptName: 'greet',
      promptArgs: [{ name: 'who', value: 'Ada' }]
    },
    comments: []
  },

  'MCP stdio - sum.mcp': {
    kind: 'mcp',
    frontmatter: {
      description:
        'stdio transport: the app SPAWNS this server. It asks for your approval the first time, showing the exact command.',
      label: ['mcp', 'stdio'],
      scripts: {
        test: `pm.test("sums over stdio", () => {
  pm.expect(pm.response.json().content[0].text).to.contain("3");
});`
      }
    },
    variables: [],
    mcp: {
      transport: 'stdio',
      command: 'node',
      args: ['../servers/mcp-stdio.mjs'],
      env: [{ name: 'WHO', value: 'freepost' }],
      headers: [],
      method: 'tools/call',
      toolName: 'get-sum',
      toolArgs: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' }
      ],
      promptArgs: []
    },
    comments: []
  },

  // ---- The other four protocols ----
  'HTTP - list users.curl': {
    kind: 'curl',
    frontmatter: {
      description: 'REST fixture: list users.',
      label: ['http'],
      scripts: {
        test: `pm.test("status is 200", () => pm.response.to.have.status(200));
pm.test("returns users", () => pm.expect(pm.response.json()).to.have.length.of.at.least(2));`
      }
    },
    variables: [{ name: 'BASE_URL', defaultValue: 'http://localhost:3010', required: false }],
    http: {
      method: 'GET',
      url: '${BASE_URL}/users',
      headers: [{ name: 'Accept', value: 'application/json' }],
      options: {}
    },
    comments: []
  },

  'HTTP - create user.curl': {
    kind: 'curl',
    frontmatter: {
      description: 'REST fixture: create a user (POST + JSON body).',
      label: ['http'],
      scripts: {
        test: `pm.test("status is 201", () => pm.response.to.have.status(201));
pm.test("echoes the name", () => pm.expect(pm.response.json().name).to.equal("Grace Hopper"));`
      }
    },
    variables: [{ name: 'BASE_URL', defaultValue: 'http://localhost:3010', required: false }],
    http: {
      method: 'POST',
      url: '${BASE_URL}/users',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      body: { kind: 'raw', value: '{"name":"Grace Hopper","email":"grace@example.com"}' },
      options: {}
    },
    comments: []
  },

  'GraphQL - users query.curl': {
    kind: 'curl',
    frontmatter: {
      description: 'GraphQL fixture: query users (GraphQL mode — the body is generated from `graphql`).',
      label: ['graphql'],
      graphql: {
        query: 'query Users {\n  users {\n    id\n    name\n    email\n  }\n}',
        variableDefs: []
      },
      scripts: {
        test: `pm.test("returns users", () => {
  pm.expect(pm.response.json().data.users).to.have.length.of.at.least(2);
});`
      }
    },
    variables: [{ name: 'GQL_URL', defaultValue: 'http://localhost:3014/graphql', required: false }],
    http: {
      method: 'POST',
      url: '${GQL_URL}',
      headers: [{ name: 'Content-Type', value: 'application/json' }],
      options: {}
    },
    comments: []
  },

  'gRPC - say hello.grpc': {
    kind: 'grpc',
    frontmatter: {
      description: 'gRPC fixture: unary SayHello.',
      label: ['grpc'],
      scripts: {
        test: `pm.test("greets dave", () => pm.expect(pm.response.json().message).to.equal("Hello dave"));`
      }
    },
    variables: [{ name: 'GRPC_TARGET', defaultValue: 'localhost:50051', required: false }],
    grpc: {
      target: '${GRPC_TARGET}',
      fullMethod: 'helloworld.Greeter/SayHello',
      plaintext: true,
      data: '{"name":"dave"}',
      metadata: [],
      protoFiles: ['../servers/greeter.proto'],
      importPaths: []
    },
    comments: []
  },

  'MQTT - publish.mqtt': {
    kind: 'mqtt',
    frontmatter: {
      description: 'MQTT fixture: publish one message (watch the broker log).',
      label: ['mqtt'],
      scripts: { test: `pm.test("published", () => pm.expect(pm.response.json().published).to.equal(true));` }
    },
    variables: [{ name: 'MQTT_HOST', defaultValue: 'localhost', required: false }],
    mqtt: {
      mode: 'publish',
      host: '${MQTT_HOST}',
      port: 1883,
      topic: 'freepost/demo',
      message: 'hello from freepost'
    },
    comments: []
  },

  'MQTT - subscribe ticks.mqtt': {
    kind: 'mqtt',
    frontmatter: {
      description: 'MQTT fixture: subscribe to the heartbeat (long-lived — connect from the app).',
      label: ['mqtt', 'streaming']
    },
    variables: [{ name: 'MQTT_HOST', defaultValue: 'localhost', required: false }],
    mqtt: { mode: 'subscribe', host: '${MQTT_HOST}', port: 1883, topic: 'freepost/tick' },
    comments: []
  },

  'WebSocket - echo.ws': {
    kind: 'websocat',
    frontmatter: {
      description: 'WebSocket fixture: echo server + a tick every 2s (long-lived — connect from the app).',
      label: ['websocket', 'streaming'],
      messages: { ping: '{"op":"ping"}', hello: 'hello fixture' }
    },
    variables: [{ name: 'WS_URL', defaultValue: 'ws://localhost:3013', required: false }],
    ws: { url: '${WS_URL}', headers: [] },
    comments: []
  }
}

for (const [name, file] of Object.entries(files)) {
  writeFileSync(join(out, name), writeRequestFile(file))
  console.log('wrote', name)
}
