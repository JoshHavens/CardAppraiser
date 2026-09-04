/*
 * Optional Claude Vision identification.
 *
 * Runs only when the user has entered their own Anthropic API key and enabled
 * the Vision engine. Called once per detected new card (not per frame), so cost
 * stays tiny (~$0.002-0.004/card on Haiku/Sonnet). The key lives in local
 * extension storage and is sent directly from the browser, which Anthropic
 * gates behind the explicit "dangerous-direct-browser-access" header.
 */

(function () {
  "use strict";

  const ENDPOINT = "https://api.anthropic.com/v1/messages";

  const SYSTEM = [
    "You identify a single trading card (usually Pokémon) held up in a frame from a live auction video stream.",
    "The image may be blurry, angled, or glare-covered. Read the card as best you can.",
    "Respond with ONLY a JSON object, no prose, no code fences, with exactly these keys:",
    '{"is_trading_card": boolean, "name": string, "set": string, "number": string, "edition": string, "grade_guess": string, "confidence": number}',
    "- is_trading_card: false if the frame shows a face, packaging, chat, or no clear single card.",
    "- name: the character/card name (e.g. \"Charizard\"). Empty string if unknown.",
    "- set: the set/series if legible (e.g. \"Base Set\", \"Scarlet & Violet 151\"). Empty if unknown.",
    "- number: the card number if legible (e.g. \"4\", \"4/102\"). Empty if unknown.",
    "- edition: one of \"1st Edition\", \"Shadowless\", \"Unlimited\", \"Reverse Holo\", or \"\" if not determinable.",
    "- grade_guess: rough condition if it's a slabbed/graded card (e.g. \"PSA 10\"), else \"\".",
    "- confidence: 0.0 to 1.0, your confidence in name+set+number.",
  ].join("\n");

  function stripToJson(text) {
    if (!text) return null;
    let t = text.trim();
    // Strip markdown fences if the model added them.
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
    const start = t.indexOf("{");
    const end = t.lastIndexOf("}");
    if (start === -1 || end === -1) return null;
    try {
      return JSON.parse(t.slice(start, end + 1));
    } catch (e) {
      return null;
    }
  }

  /**
   * @param {string} dataUrl  "data:image/jpeg;base64,..."
   * @param {object} opts     { apiKey, model }
   * @returns {Promise<object>} parsed identity
   */
  async function identify(dataUrl, opts) {
    const { apiKey, model } = opts;
    if (!apiKey) throw new Error("No Anthropic API key set.");

    const m = /^data:(image\/\w+);base64,(.*)$/s.exec(dataUrl || "");
    if (!m) throw new Error("Bad image data.");
    const mediaType = m[1];
    const b64 = m[2];

    const body = {
      model: model || "claude-haiku-4-5",
      max_tokens: 400,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: "Identify this card. JSON only." },
          ],
        },
      ],
    };

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).error?.message || ""; } catch (e) {}
      throw new Error(`Anthropic HTTP ${res.status}${detail ? ": " + detail : ""}`);
    }

    const json = await res.json();
    const textBlock = (json.content || []).find((b) => b.type === "text");
    const parsed = stripToJson(textBlock ? textBlock.text : "");
    if (!parsed) throw new Error("Could not parse model response.");
    return {
      is_trading_card: parsed.is_trading_card !== false,
      name: parsed.name || "",
      set: parsed.set || "",
      number: parsed.number || "",
      edition: parsed.edition || "",
      grade_guess: parsed.grade_guess || "",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
      source: "vision",
      usage: json.usage || null,
    };
  }

  self.Vision = { identify };
})();
