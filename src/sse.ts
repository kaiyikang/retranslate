// 把 OpenRouter 的 SSE 字节流转成只含译文的纯文本流
export function sseToText(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = "";
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, ctl) {
        buf += decoder.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!; // 最后一行可能不完整，留到下个 chunk
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue; // 跳过空行和 ": OPENROUTER PROCESSING" 之类的注释
          const data = line.slice(6).trim();
          if (data === "[DONE]") continue;
          const json = JSON.parse(data);
          if (json.error) throw new Error(json.error.message); // 流中途出错
          const text = json.choices?.[0]?.delta?.content;
          if (text) ctl.enqueue(encoder.encode(text));
        }
      },
    }),
  );
}
