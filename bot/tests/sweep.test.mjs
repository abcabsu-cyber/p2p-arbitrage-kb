// F-05 + F-06 + F-12: надёжное удаление просроченных, пропускная способность, заявки без оплаты.
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkWorld, mkEnv, install, restore, scheduled, freezeAt, joinRequest, ownerSay, getJSON, OWNER } from "./harness.mjs";

let world;
beforeEach(() => { world = mkWorld(); install(world); });
afterEach(restore);
const DEC20 = Date.UTC(2026, 11, 20, 12, 30), CH = "-1001";
const expired = (env, uid, until = Date.UTC(2026, 11, 10)) => env.SUBS.put("paid:" + uid, JSON.stringify({ until, orders: ["o"] }), { metadata: { until } });
const bans = () => world.tg.filter((x) => x.method === "banChatMember");
const ownerMsgs = () => world.tg.filter((x) => x.method === "sendMessage" && String(x.b.chat_id) === OWNER).map((x) => x.b.text);

test("F-05: сбой Telegram не помечает человека обработанным, следующий проход его удаляет", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH }); await expired(env, 700); world.members.add(CH + ":700");
  world.tgFail = (m) => m === "getChatMember";
  await scheduled(env);
  assert.equal(await env.SUBS.get("kick:700"), null, "метка поставлена при сбое");
  assert.equal(bans().length, 0);
  world.tgFail = null;
  await scheduled(env);
  assert.equal(bans().length, 1);
  assert.equal(world.members.has(CH + ":700"), false);
  assert.equal(await env.SUBS.get("kick:700"), "1");
});

test("F-05: сбой самого удаления тоже повторяется", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH }); await expired(env, 701); world.members.add(CH + ":701");
  world.tgFail = (m) => m === "banChatMember";
  await scheduled(env);
  assert.equal(await env.SUBS.get("kick:701"), null);
  world.tgFail = null; await scheduled(env);
  assert.equal(world.members.has(CH + ":701"), false);
});

test("F-05: владелец узнаёт о повторяющихся сбоях не чаще раза в сутки", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH }); await expired(env, 702); world.members.add(CH + ":702");
  world.tgFail = (m) => m === "getChatMember";
  await scheduled(env); await scheduled(env); await scheduled(env);
  assert.equal(ownerMsgs().filter((t) => t.includes("не удалось проверить")).length, 1);
});

test("F-05 (негативный): человека вне канала отмечают без ошибки, действующий доступ не трогают", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH });
  await expired(env, 703);                                       // просрочен, в канале нет
  await expired(env, 704, Date.UTC(2027, 0, 15)); world.members.add(CH + ":704");   // действует
  await scheduled(env);
  assert.equal(await env.SUBS.get("kick:703"), "0");
  assert.equal(await env.SUBS.get("kick:704"), null);
  assert.equal(world.members.has(CH + ":704"), true);
});

test("F-05 (негативный): до даты запуска никого не удаляют", async () => {
  freezeAt(Date.UTC(2026, 10, 20));
  const env = mkEnv({ PRIVATE_CHANNEL: CH }); await expired(env, 705, Date.UTC(2026, 10, 10)); world.members.add(CH + ":705");
  await scheduled(env);
  assert.equal(bans().length, 0);
});

// одно обращение воркера не должно делать больше ~50 вызовов (KV + Telegram), иначе на бесплатном плане часть работы молча обрывается
const calls = (env) => env.SUBS.ops + world.tg.length + world.docs.length;
async function runCounted(env) { const c0 = calls(env); await scheduled(env); return calls(env) - c0; }

test("F-06/F-N5: 200 просроченных удаляются за несколько проходов, каждый проход укладывается в бюджет", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH, SWEEP_KICK_BATCH: "100" });
  for (let i = 0; i < 200; i++) { await expired(env, 1000 + i); world.members.add(CH + ":" + (1000 + i)); }
  let runs = 0;
  while (bans().length < 200 && runs < 80) { const used = await runCounted(env); assert.ok(used <= 50, "проход сделал " + used + " вызовов"); runs++; }
  assert.equal(bans().length, 200);
});

test("F-N5: очередь заявок и очередь удалений вместе не превышают бюджет, удаления не голодают", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH, SWEEP_JOIN_BATCH: "100", SWEEP_KICK_BATCH: "100" });
  for (let i = 0; i < 100; i++) { await env.SUBS.put("jr:" + (3000 + i), "1"); await env.SUBS.put("paid:" + (3000 + i), JSON.stringify({ until: Date.UTC(2027, 0, 15) }), { metadata: { until: Date.UTC(2027, 0, 15) } }); }
  for (let i = 0; i < 20; i++) { await expired(env, 2000 + i); world.members.add(CH + ":" + (2000 + i)); }
  const used = await runCounted(env);
  assert.ok(used <= 50, "проход сделал " + used + " вызовов");
  assert.ok(world.tg.filter((x) => x.method === "approveChatJoinRequest").length >= 1);
  assert.ok(bans().length >= 1, "удаления просроченных не должны ждать, пока опустеет очередь заявок");
});

test("F-06: размеры порции из настройки действуют как верхняя граница", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH, SWEEP_JOIN_BATCH: "3", SWEEP_KICK_BATCH: "2" });
  for (let i = 0; i < 20; i++) { await expired(env, 2000 + i); world.members.add(CH + ":" + (2000 + i)); await env.SUBS.put("jr:" + (3000 + i), "1"); await env.SUBS.put("paid:" + (3000 + i), JSON.stringify({ until: Date.UTC(2027, 0, 15) }), { metadata: { until: Date.UTC(2027, 0, 15) } }); }
  await scheduled(env);
  assert.equal(bans().length, 2);
  assert.equal(world.tg.filter((x) => x.method === "approveChatJoinRequest").length, 3);
});

test("F-06: при частом расписании суточная копия уходит один раз", async () => {
  const env = mkEnv({ PRIVATE_CHANNEL: CH });
  for (const min of [0, 10, 20, 30, 40, 50]) { freezeAt(Date.UTC(2026, 11, 20, 6, min)); await scheduled(env); }
  assert.equal(world.docs.length, 1);
  freezeAt(Date.UTC(2026, 11, 20, 9, 0)); await scheduled(env);
  assert.equal(world.docs.length, 1, "копия не должна уходить в другие часы");
});

test("F-12: ожидающая заявка без оплаты в день запуска отклоняется, заявка с оплатой одобряется", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH });
  await env.SUBS.put("jr:800", CH); await env.SUBS.put("jr:801", CH);
  await env.SUBS.put("paid:801", JSON.stringify({ until: Date.UTC(2027, 0, 15) }), { metadata: { until: Date.UTC(2027, 0, 15) } });
  await scheduled(env);
  assert.ok(world.tg.some((x) => x.method === "declineChatJoinRequest" && x.b.user_id === 800));
  assert.ok(world.tg.some((x) => x.method === "approveChatJoinRequest" && x.b.user_id === 801));
  assert.equal(await env.SUBS.get("jr:800"), null);
});

test("/revoke по-прежнему удаляет из канала и закрывает доступ", async () => {
  freezeAt(DEC20);
  const env = mkEnv({ PRIVATE_CHANNEL: CH }); await expired(env, 900, Date.UTC(2027, 0, 15)); world.members.add(CH + ":900");
  await ownerSay(env, "/revoke 900");
  assert.equal(await env.SUBS.get("paid:900"), null);
  assert.equal(world.members.has(CH + ":900"), false);
});
