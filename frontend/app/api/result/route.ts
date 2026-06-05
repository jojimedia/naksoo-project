import { readFile } from "fs/promises";
import path from "path";

const RESULT_PATHS = [
  path.join(process.cwd(), "..", "backend", "data", "result.json"),
  path.join(process.cwd(), "backend", "data", "result.json"),
  path.join(process.cwd(), "public", "data", "result.json"),
];

export const dynamic = "force-dynamic";

export async function GET() {
  for (const resultPath of RESULT_PATHS) {
    try {
      const raw = await readFile(resultPath, "utf-8");

      return new Response(raw, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        },
      });
    } catch {
      continue;
    }
  }

  return Response.json(
    {
      error: "result_not_found",
      paths: RESULT_PATHS,
    },
    { status: 404 },
  );
}
