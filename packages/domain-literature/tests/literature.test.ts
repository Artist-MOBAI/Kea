import { describe, expect, test } from "vitest";
import { buildArxivUrl, parseArxivAtom } from "../src/arxiv.ts";
import { buildCrossrefUrl } from "../src/crossref.ts";
import { buildS2DoiUrl, buildS2SearchUrl, mapS2Response } from "../src/semanticscholar.ts";

const ATOM_FIXTURE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
<entry>
  <id>http://arxiv.org/abs/2501.00001v2</id>
  <title>  Thermoelectric  skutterudites
 revisited </title>
  <summary>We report a zT of 1.4.</summary>
  <published>2025-01-01T00:00:00Z</published>
  <author><name>Alice Zhang</name></author>
  <author><name>Bob Li</name></author>
  <arxiv:doi>10.1000/demo.2025</arxiv:doi>
</entry>
<entry>
  <id>http://arxiv.org/abs/2501.00002v1</id>
  <title>No doi paper</title>
  <summary>Short.</summary>
</entry>
</feed>`;

describe("arXiv client (M5)", () => {
	test("URL construction carries search_query and max_results", () => {
		const url = buildArxivUrl({ search: "skutterudite zT", maxResults: 5 });
		expect(url).toContain("export.arxiv.org/api/query");
		expect(url).toContain("max_results=5");
		expect(decodeURIComponent(url.replace(/\+/g, " "))).toContain("search_query=all:skutterudite zT");
	});

	test("Atom parsing: title line-fold normalization, author list, DOI, version suffix stripped", () => {
		const papers = parseArxivAtom(ATOM_FIXTURE);
		expect(papers).toHaveLength(2);
		const first = papers[0];
		expect(first?.arxivId).toBe("2501.00001");
		expect(first?.title).toBe("Thermoelectric skutterudites revisited");
		expect(first?.authors).toEqual(["Alice Zhang", "Bob Li"]);
		expect(first?.doi).toBe("10.1000/demo.2025");
		expect(papers[1]?.doi).toBeUndefined();
	});

	test("malformed character entities (out-of-range code point / NaN) do not throw RangeError, degrade to empty", () => {
		const xml = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <id>http://arxiv.org/abs/2501.00009v1</id>
  <title>Bad entity &#1114112; end</title>
  <summary>hex &#x110000; only</summary>
</entry>
</feed>`;
		const papers = parseArxivAtom(xml);
		expect(papers).toHaveLength(1);
		expect(papers[0]?.title).toBe("Bad entity end");
		expect(papers[0]?.abstract).toBe("hex only");
	});
});

describe("Semantic Scholar / Crossref (M5)", () => {
	test("URL construction carries fields and the DOI path", () => {
		expect(buildS2SearchUrl("band gap perovskite", 3)).toContain("fields=");
		expect(buildS2SearchUrl("x", 3)).toContain("limit=3");
		expect(buildS2DoiUrl("10.1000/demo")).toContain("/paper/DOI:10.1000%2Fdemo");
		expect(buildCrossrefUrl("10.1000/demo")).toContain("/works/10.1000%2Fdemo");
	});

	test("mapS2Response fault tolerance: invalid structures return an empty array", () => {
		expect(mapS2Response({ data: [{ paperId: "p1", title: "t", authors: [] }] })).toHaveLength(1);
		expect(mapS2Response({ junk: true })).toEqual([]);
	});
});
