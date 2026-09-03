import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

process.env.OMP_WEB_HOSTS_FILE = "/nonexistent";
const jiti = createJiti(import.meta.url);
const {
  GATEWAY_PROVIDER_NAME,
  parseGatewayModels,
  withGatewayProvider,
  withoutGatewayProvider,
} = await jiti.import("./credentials.ts");

const ENDPOINTS = { gatewayUrl: "https://hub.example:8791", gatewayToken: "gw-token" };

test("gateway models are read from the gateway's own listing", () => {
  // Fetched rather than hardcoded, so a machine is offered exactly what the
  // gateway can serve and the list refreshes whenever the policy reapplies.
  const models = parseGatewayModels({
    object: "list",
    data: [
      { id: "anthropic/claude-haiku-4-5", api: "anthropic-messages", context_length: 200000, max_output_tokens: 8192 },
      { id: "openai/gpt-5", api: "openai-completions" },
      { id: "", api: "openai-completions" },
      { not: "a model" },
      "nonsense",
    ],
  });
  assert.deepEqual(models, [
    { id: "anthropic/claude-haiku-4-5", api: "anthropic-messages", contextWindow: 200000, maxTokens: 8192 },
    { id: "openai/gpt-5", api: "openai-completions" },
  ]);
});

test("a malformed listing yields nothing rather than a broken provider", () => {
  assert.deepEqual(parseGatewayModels(null), []);
  assert.deepEqual(parseGatewayModels({}), []);
  assert.deepEqual(parseGatewayModels({ data: "not-an-array" }), []);
});

test("the gateway provider is written without disturbing the machine's own", () => {
  // A machine's models.yml is not ours to own: we replace one named provider
  // and leave everything the user defined alone.
  const existing = {
    providers: {
      "my-own-provider": { baseUrl: "https://elsewhere.example", apiKey: "keep-me", models: [{ id: "x", api: "openai-completions" }] },
    },
    somethingElse: true,
  };
  const next = withGatewayProvider(existing, ENDPOINTS, [{ id: "anthropic/claude-haiku-4-5", api: "anthropic-messages" }]);

  assert.deepEqual(next.providers["my-own-provider"], existing.providers["my-own-provider"]);
  assert.equal(next.somethingElse, true);
  const gateway = next.providers[GATEWAY_PROVIDER_NAME];
  assert.equal(gateway.baseUrl, "https://hub.example:8791/v1");
  assert.equal(gateway.apiKey, "gw-token");
  assert.deepEqual(gateway.models, [{ id: "anthropic/claude-haiku-4-5", api: "anthropic-messages" }]);
  // The input is not mutated in place.
  assert.equal(GATEWAY_PROVIDER_NAME in existing.providers, false);
});

test("switching away from the gateway removes only our provider", () => {
  const withGateway = withGatewayProvider(
    { providers: { mine: { baseUrl: "https://elsewhere.example" } } },
    ENDPOINTS,
    [{ id: "m", api: "openai-completions" }],
  );
  const cleared = withoutGatewayProvider(withGateway);
  assert.equal(GATEWAY_PROVIDER_NAME in cleared.providers, false);
  assert.ok(cleared.providers.mine);
  // Nothing to remove is a no-op, so no pointless write is issued.
  const untouched = { providers: { mine: {} } };
  assert.equal(withoutGatewayProvider(untouched), untouched);
});

test("policy application never puts a token on a command line", async () => {
  const { applyCredentialPolicy } = await jiti.import("./credentials.ts");
  const calls = [];
  const host = {
    id: "shared-box",
    isLocal: false,
    ompBin: "omp",
    executor: {
      async exec(argv, options = {}) {
        calls.push({ argv, options });
        // Pretend no broker pointer exists, so "local" has nothing to undo.
        return { stdout: Buffer.from(""), stderr: "", code: 0, signal: null };
      },
    },
    fs: {
      async readFile() { return Buffer.from(""); },
      async exists() { return false; },
    },
  };

  await applyCredentialPolicy(host, "broker", { brokerUrl: "https://vault.example:9000", brokerToken: "super-secret-broker-token" });

  const flattened = JSON.stringify(calls.map((call) => call.argv));
  assert.doesNotMatch(flattened, /super-secret-broker-token/, "the token must never reach argv");
  const tokenCall = calls.find((call) => call.argv.includes("auth.broker.token"));
  assert.ok(tokenCall, "the token is still set");
  assert.equal(tokenCall.options.secretEnv.OMPWEB_BROKER_TOKEN, "super-secret-broker-token");
  // The remote shell expands it from the value read on stdin.
  assert.ok(tokenCall.argv.includes("$OMPWEB_BROKER_TOKEN"));
  // The URL is not secret and rides along normally.
  assert.ok(calls.some((call) => call.argv.includes("https://vault.example:9000")));
});

test("a machine without omp cannot be configured, and says so", async () => {
  const { applyCredentialPolicy } = await jiti.import("./credentials.ts");
  await assert.rejects(
    () => applyCredentialPolicy({ id: "x", ompBin: null, isLocal: false }, "broker", { brokerUrl: "https://v.example" }),
    (error) => error.code === "omp_missing",
  );
});
