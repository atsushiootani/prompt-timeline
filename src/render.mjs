/**
 * Bake a collected day into a single self-contained HTML file.
 *
 * The CSS, the JS and the data all get inlined, so the result opens with a
 * double click: no server, no build step, no CDN fetch at view time.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VIEW_DIR = path.join(HERE, "..", "view");
export const DEFAULT_ICON = path.join(HERE, "..", "assets", "concier-chan.png");

// U+2028 / U+2029 are valid in JSON strings but end a line in JavaScript source,
// so they have to be escaped before the payload is inlined into a <script> block.
// Built from char codes rather than written literally, to keep this file plain ASCII.
const LINE_SEPARATORS = [
  [new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028"],
  [new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029"],
];

/** Make a JSON payload safe to sit inside a <script> block. */
function inlineJson(data) {
  let json = JSON.stringify(data).replace(/</g, "\\u003c");
  for (const [pattern, replacement] of LINE_SEPARATORS) json = json.replace(pattern, replacement);
  return json;
}

/** The mascot, inlined so the page stays a single file. Missing art is not fatal. */
async function loadIcon(file) {
  try {
    return `data:image/png;base64,${(await readFile(file)).toString("base64")}`;
  } catch {
    return "";
  }
}

export async function render(data, options = {}) {
  const { viewDir = DEFAULT_VIEW_DIR, iconFile = DEFAULT_ICON, title } = options;

  const [template, css, js, icon] = await Promise.all([
    readFile(path.join(viewDir, "template.html"), "utf8"),
    readFile(path.join(viewDir, "timeline.css"), "utf8"),
    readFile(path.join(viewDir, "timeline.js"), "utf8"),
    loadIcon(iconFile),
  ]);

  const slots = {
    __TITLE__: title ?? `Prompt Timeline ${data.date ?? ""}`.trim(),
    __CSS__: css,
    __DATA__: inlineJson(data),
    __JS__: js,
    __ICON__: icon,
  };

  // Fill every slot in a single pass. Replacing them one after another would let
  // content inserted earlier (a prompt body, say) be scanned for later tokens.
  return template.replace(/__(?:TITLE|CSS|DATA|JS|ICON)__/g, (token) => slots[token]);
}
