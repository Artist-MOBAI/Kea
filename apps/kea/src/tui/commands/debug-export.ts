import { CORE_VERSION, listJobIds, readMeta, runDoctor } from "@kea/core";
import { Journal } from "@kea/research";

// Safety discipline: metadata and stats only — no env secret values, no session transcript.
export async function collectDebugBundle(cwd: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {};

	const checks = await runDoctor(cwd);
	files["doctor.txt"] = checks
		.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}${c.hint ? ` — ${c.hint}` : ""}`)
		.join("\n");

	files["status.json"] = JSON.stringify(
		{
			version: CORE_VERSION,
			platform: `${process.platform}-${process.arch}`,
			bun: process.versions.bun,
			exportedAt: new Date().toISOString(),
		},
		null,
		2,
	);

	const jobs: unknown[] = [];
	for (const id of await listJobIds(cwd)) {
		const meta = await readMeta(cwd, id);
		if (meta) jobs.push({ id, ...meta });
	}
	files["jobs.json"] = JSON.stringify(jobs, null, 2);

	const counts: Record<string, number> = {};
	try {
		for (const event of new Journal(cwd).list({ limit: 1000 })) {
			counts[event.type] = (counts[event.type] ?? 0) + 1;
		}
	} catch {
		// Leave stats empty when the journal is missing/corrupt; do not block the export.
	}
	files["journal-summary.json"] = JSON.stringify(counts, null, 2);

	return files;
}
