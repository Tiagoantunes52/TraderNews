import { runPipeline } from "../src/lib/pipeline";

async function main() {
  try {
    const result = await runPipeline();
    console.log("OK", JSON.stringify(result, null, 2).slice(0, 2000));
  } catch (e) {
    console.error("PIPELINE_ERROR:", e);
    if (e instanceof Error) console.error("STACK:", e.stack);
  }
}
main();
