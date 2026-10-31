import { test } from "node:test";
import assert from "node:assert/strict";
import { sseToText } from "./sse.ts";

const enc = new TextEncoder();
const stream = (...chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(ctl) {
      for (const c of chunks) ctl.enqueue(c);
      ctl.close();
    },
  });
const delta = (s: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;

test("拼接 delta，跳过注释和 [DONE]，处理切在多字节字符中间的 chunk", async () => {
  const raw = ": OPENROUTER PROCESSING\n\n" + delta("城堡") + delta("；锁") + "data: [DONE]\n\n";
  const bytes = enc.encode(raw);
  const cut = enc.encode(raw.slice(0, raw.indexOf("城"))).length + 1; // "城" 的第 2 个字节
  const out = sseToText(stream(bytes.slice(0, cut), bytes.slice(cut)));
  assert.equal(await new Response(out).text(), "城堡；锁");
});

test("流中途的 error 事件让流失败", async () => {
  const out = sseToText(stream(enc.encode(delta("a") + `data: ${JSON.stringify({ error: { message: "boom" } })}\n\n`)));
  await assert.rejects(new Response(out).text(), /boom/);
});
