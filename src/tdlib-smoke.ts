import { load } from "koffi";
import { resolveTdlibLibrary } from "./tdlib-session.js";

const libraryPath = await resolveTdlibLibrary();
const library = load(libraryPath);
const execute = library.func("const char *td_execute(const char *request)");
const result = execute(
  JSON.stringify({
    "@type": "getTextEntities",
    text: "TDLib local smoke test",
  }),
);
if (typeof result !== "string") {
  throw new Error("TDLib getTextEntities returned no JSON response");
}
const parsed: unknown = JSON.parse(result);
if (
  !parsed ||
  typeof parsed !== "object" ||
  !("@type" in parsed) ||
  parsed["@type"] !== "textEntities"
) {
  throw new Error("TDLib getTextEntities returned an unexpected response");
}
process.stdout.write("TDLib local JSON API smoke test passed.\n");
