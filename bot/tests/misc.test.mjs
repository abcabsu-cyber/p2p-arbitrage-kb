// F-07 (возврат), F-08 (бан), F-11 (сообщения покупателю).
import test, { beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkWorld, mkEnv, install, restore, req, hook2328, ownerSay, joinRequest, getJSON, OWNER } from "./harness.mjs";

let world, env;
const base = (over = {}) => mkEnv({ PAY2328_KEY: "key-2328-test", PAY2328_PROJECT: "p", PRIVATE_CHANNEL: "-1001", COURSE_CH_ECO: "-2001", COURSE_CH_STD: "-2002", COURSE_CH_PRO: "-2003", ...over });
beforeEach(() => { world = mkWorld(); install(world); env = base(); });
afterEach(restore);
const ownerMsgs = () => world.tg.filter((x) => x.method === "sendMessage" && String(x.b.chat_id) === OWNER).map((x) => x.b.text);
const userMsgs = (uid) => world.tg.filter((x) => x.method === "sendMessage" && String(x.b.chat_id) === String(uid)).map((x) => x.b.text);
const pay = async (e, order, st, extra = {}) => req(e, "/pay/webhook2328", hook2328({ order_id: order, uuid: "u-" + order, payment_status: st, amount: "4990", currency: "RUB", ...extra }));
const seedOrder = (e, order, uid, extra = {}) => e.SUBS.put("ord:" + order, JSON.stringify({ uid, p: "2328", ...extra }));

// ---- F-07
test("F-07: возврат по умолчанию не закрывает доступ, но владелец получает готовую команду", async () => {
  await seedOrder(env, "u10-a", 10); await pay(env, "u10-a", "paid");
  await pay(env, "u10-a", "refund_paid");
  assert.ok(await getJSON(env, "paid:10"));
  assert.ok(ownerMsgs().some((t) => t.includes("/revoke 10")), "нет готовой команды отзыва");
});

test("F-07: для курса в сообщении команда /revokecourse", async () => {
  await seedOrder(env, "u11-a", 11, { product: "course", tier: "std" }); await pay(env, "u11-a", "paid", { amount: "24990" });
  await pay(env, "u11-a", "refund_paid", { amount: "24990" });
  assert.ok(ownerMsgs().some((t) => t.includes("/revokecourse 11")));
});

test("F-07: AUTO_REVOKE_ON_REFUND=1 закрывает доступ и убирает из канала (приват)", async () => {
  const e = base({ AUTO_REVOKE_ON_REFUND: "1" }); await seedOrder(e, "u12-a", 12); await pay(e, "u12-a", "paid");
  world.members.add("-1001:12");
  await pay(e, "u12-a", "refund_paid");
  assert.equal(await e.SUBS.get("paid:12"), null);
  assert.equal(world.members.has("-1001:12"), false);
});

test("F-07: AUTO_REVOKE_ON_REFUND=1 для курса отзывает курс и бонус", async () => {
  const e = base({ AUTO_REVOKE_ON_REFUND: "1" }); await seedOrder(e, "u13-a", 13, { product: "course", tier: "eco" }); await pay(e, "u13-a", "paid", { amount: "9990" });
  world.members.add("-2001:13");
  await pay(e, "u13-a", "refund_paid", { amount: "9990" });
  assert.equal(await e.SUBS.get("course:13"), null);
  assert.equal(await e.SUBS.get("paid:13"), null);
  assert.equal(world.members.has("-2001:13"), false);
});

test("F-07 (негативный): автоотзыв не затрагивает другие оплаты того же человека и других людей", async () => {
  const e = base({ AUTO_REVOKE_ON_REFUND: "1" });
  await seedOrder(e, "u14-a", 14); await seedOrder(e, "u14-b", 14); await seedOrder(e, "u15-a", 15);
  await pay(e, "u14-a", "paid"); await pay(e, "u14-b", "paid"); await pay(e, "u15-a", "paid");
  await pay(e, "u14-a", "refund_paid");
  assert.ok(await getJSON(e, "paid:14"), "у человека есть вторая оплата: доступ не закрывать автоматически");
  assert.ok(await getJSON(e, "paid:15"));
  assert.ok(ownerMsgs().some((t) => t.includes("вручную")));
});

// ---- F-08
test("F-08: /ban убирает из каналов привата и курса, записи оплат остаются; /unban их не теряет", async () => {
  await env.SUBS.put("paid:20", JSON.stringify({ until: Date.UTC(2027, 0, 1), orders: ["o"] }), { metadata: { until: Date.UTC(2027, 0, 1) } });
  await env.SUBS.put("course:20", JSON.stringify({ tier: "eco", orders: ["o"] }));
  world.members.add("-1001:20"); world.members.add("-2001:20");
  await ownerSay(env, "/ban 20");
  assert.equal(world.members.has("-1001:20"), false);
  assert.equal(world.members.has("-2001:20"), false);
  assert.ok(await getJSON(env, "paid:20")); assert.ok(await getJSON(env, "course:20"));
  await ownerSay(env, "/unban 20");
  assert.ok(await getJSON(env, "paid:20"));
  assert.equal(await env.SUBS.get("ban:20"), null);
});

test("F-08: заявка забаненного в канал отклоняется", async () => {
  await env.SUBS.put("ban:21", "1");
  await env.SUBS.put("paid:21", JSON.stringify({ until: Date.UTC(2027, 0, 1) }), { metadata: { until: Date.UTC(2027, 0, 1) } });
  await joinRequest(env, 21, -1001);
  assert.ok(world.tg.some((x) => x.method === "declineChatJoinRequest" && x.b.user_id === 21));
});

test("F-08: оплата от забаненного не теряется молча — владельцу приходит пометка", async () => {
  await env.SUBS.put("ban:22", "1");
  await seedOrder(env, "u22-a", 22); await pay(env, "u22-a", "paid");
  assert.ok(ownerMsgs().some((t) => t.includes("исключён")), "в уведомлении нет пометки о бане");
});

test("F-08 (негативный): /ban от постороннего не действует", async () => {
  await ownerSay(env, "/ban 23", { from: 555, chat: 555 });
  assert.equal(await env.SUBS.get("ban:23"), null);
});

// ---- F-11
test("F-11: при недоплате покупатель получает сообщение с контактом, один раз на заказ", async () => {
  await seedOrder(env, "u30-a", 30);
  await pay(env, "u30-a", "underpaid"); await pay(env, "u30-a", "underpaid");
  const m = userMsgs(30);
  assert.equal(m.length, 1);
  assert.ok(m[0].includes("t.me/hanballit") && m[0].includes("u30-a"));
});

test("F-11: при сбое платёжной системы покупатель тоже получает сообщение", async () => {
  await seedOrder(env, "u31-a", 31); await pay(env, "u31-a", "system_fail");
  assert.equal(userMsgs(31).length, 1);
});

test("F-11 (негативный): возвраты и неизвестные статусы покупателю не пишут и доступ не дают", async () => {
  await seedOrder(env, "u32-a", 32);
  for (const st of ["refund_process", "cancel", "process", "weird"]) await pay(env, "u32-a", st);
  assert.equal(userMsgs(32).length, 0);
  assert.equal(await env.SUBS.get("paid:32"), null);
});

test("F-11 (негативный): уведомление о недоплате без привязки к пользователю не падает", async () => {
  const r = await pay(env, "unknown-order", "underpaid");
  assert.equal(r.status, 200);
});
