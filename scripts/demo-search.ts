// SPDX-License-Identifier: AGPL-3.0-or-later WITH MarxSphere-Exception
import { searchService } from "../src/services/search-service.js";
import { closePool } from "../src/db/pool.js";

const query = process.argv.slice(2).join(" ") || "How does SAG multi search work?";

try {
  const result = await searchService.search({
    query,
    sourceIds: ["c609acbf-1d6e-4bd5-9ae1-92fa6c64021a"],
    strategy: "multi",
    topK: 5,
    returnTrace: true
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closePool();
}
