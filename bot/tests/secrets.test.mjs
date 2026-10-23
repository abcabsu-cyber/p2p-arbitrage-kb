// F-02: отдельные секреты и команды владельца только из его личного чата.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkWorld, mkEnv, install, restore, req, initData, user, ownerSay, getJSON, SECRET, OWNER } from "./harness.mjs";

let world;
beforeEach(() => { world = mkWorld(); install(world); });
afterEach(restore);
const token = async (env) => (await (await req(env, "/api/session", { body: { initData: initData(user(555)) } })).json()).token;
const material = (env, t) => req(env, "/c/content/materials.json?t=" + encodeURIComponent(t), { method: "GET" });

test("команды владельца из группового чата не выполняются", async () => {
  const env = mkEnv();
  await ownerSay(env, "/grant 4242", { chat: -100123, chatType: "supergroup" });
  assert.equal(await env.SUBS.get("paid:4242"), null);
});

test("команды владельца с подставленным chat.id не выполняются и файлы не уходят постороннему", async () => {
  const env = mkEnv();
  await env.SUBS.put("paid:1", JSON.stringify({ until: 1 }), { metadata: { until: 1 } });
  await ownerSay(env, "/backup", { chat: 31337 });
  await ownerSay(env, "/users", { chat: 31337 });
  assert.equal(world.docs.length, 0, "файл ушёл в чужой чат");
});

test("/backup и /users из личного чата владельца присылают файл ему", async () => {
  const env = mkEnv();
  await env.SUBS.put("paid:1", JSON.stringify({ until: 1 }), { metadata: { until: 1 } });
  await ownerSay(env, "/backup"); await ownerSay(env, "/users");
  assert.equal(world.docs.length, 2);
  assert.ok(world.docs.every((d) => d.chat === OWNER));
});

test("обычные команды владельца в личном чате работают", async () => {
  const env = mkEnv();
  await ownerSay(env, "/grant 4242");
  assert.ok(await getJSON(env, "paid:4242"));
});

test("SESSION_SECRET: токен, подписанный прежним ключом, перестаёт работать", async () => {
  const before = mkEnv(); const t = await token(before);
  assert.equal((await material(before, t)).status !== 403, true);
  const after = mkEnv({ SESSION_SECRET: "new-session-secret-xyz" });
  assert.equal((await material(after, t)).status, 403);
  const t2 = await token(after);
  assert.notEqual((await material(after, t2)).status, 403);
});

test("SESSION_SECRET: токен нельзя подделать, зная только WEBHOOK_SECRET", async () => {
  const env = mkEnv({ SESSION_SECRET: "new-session-secret-xyz" });
  const legacy = await token(mkEnv());   // подписан WEBHOOK_SECRET
  assert.equal((await material(env, legacy)).status, 403);
});

test("SETUP_KEY: /setup открывается только своим ключом", async () => {
  const env = mkEnv({ SETUP_KEY: "setup-key-abc" });
  assert.equal((await req(env, "/setup?key=" + SECRET, { method: "GET" })).status, 403);
  assert.equal((await req(env, "/setup?key=wrong", { method: "GET" })).status, 403);
  const r = await req(env, "/setup?key=setup-key-abc", { method: "GET" });
  assert.equal(r.status, 200);
  const sw = world.tg.find((x) => x.method === "setWebhook");
  assert.equal(sw.b.secret_token, SECRET);
});

test("без SETUP_KEY /setup работает по WEBHOOK_SECRET (обратная совместимость)", async () => {
  const env = mkEnv();
  assert.equal((await req(env, "/setup?key=" + SECRET, { method: "GET" })).status, 200);
});

test("после замены WEBHOOK_SECRET старый секрет в заголовке отклоняется", async () => {
  const env = mkEnv({ WEBHOOK_SECRET: "brand-new-webhook-secret-456" });
  await ownerSay(env, "/grant 4242", { secret: SECRET });
  assert.equal(await env.SUBS.get("paid:4242"), null);
  await ownerSay(env, "/grant 4242", { secret: "brand-new-webhook-secret-456" });
  assert.ok(await getJSON(env, "paid:4242"));
});
