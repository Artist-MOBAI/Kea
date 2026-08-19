import { describe, expect, test } from "vitest";
import { deriveProviderId, mergeCustomProvider, validateContextWindow } from "../src/tui/controllers/model-config.ts";

describe("add-model wizard: context window validation", () => {
	test("accepts blank (default) and positive decimal integers", () => {
		expect(validateContextWindow("")).toBeUndefined();
		expect(validateContextWindow("1")).toBeUndefined();
		expect(validateContextWindow("131072")).toBeUndefined();
	});

	test("rejects non-integers and non-positive values", () => {
		for (const bad of ["1.5", "2e3", "1e3", "0", "-5", "abc", "12abc", " 12", "Infinity"]) {
			expect(validateContextWindow(bad), bad).toBe("Must be a positive integer");
		}
	});
});

describe("deriveProviderId (baseUrl hostname → provider id)", () => {
	test("strips the api.* prefix and lowercases", () => {
		expect(deriveProviderId("https://api.mylab.ai/v1")).toBe("mylab");
		expect(deriveProviderId("https://API.MyLab.ai/v1")).toBe("mylab");
		expect(deriveProviderId("https://mylab.ai/v1")).toBe("mylab");
		expect(deriveProviderId("http://localhost:8080/v1")).toBe("localhost");
	});

	test("falls back to custom for IP literals, IPv6, and schema-invalid hosts", () => {
		expect(deriveProviderId("http://192.168.1.1:8080/v1")).toBe("custom");
		expect(deriveProviderId("http://[::1]:8080/v1")).toBe("custom");
		expect(deriveProviderId("https://_service.example.com/v1")).toBe("custom");
		expect(deriveProviderId("not a url")).toBe("custom");
	});
});

describe("mergeCustomProvider (/model add re-registration keeps sibling models)", () => {
	const existing = [
		{
			id: "mylab",
			baseUrl: "https://api.mylab.ai/v1",
			apiKeyEnv: "MYLAB_API_KEY",
			models: [
				{ id: "researcher-7b", contextWindow: 32768 },
				{ id: "researcher-72b", contextWindow: 131072 },
			],
		},
	];

	test("re-adding a model merges into the existing provider and keeps siblings", () => {
		const merged = mergeCustomProvider(existing, {
			id: "mylab",
			baseUrl: "https://api2.mylab.ai/v1",
			apiKeyEnv: "MYLAB_API_KEY",
			models: [{ id: "researcher-7b", contextWindow: 65536 }],
		});
		expect(merged).toHaveLength(1);
		const provider = merged[0];
		expect(provider?.models.map((m) => m.id)).toEqual(["researcher-7b", "researcher-72b"]);
		expect(provider?.models[0]?.contextWindow).toBe(65536);
		expect(provider?.baseUrl).toBe("https://api2.mylab.ai/v1");
	});

	test("a brand-new provider id is appended", () => {
		const merged = mergeCustomProvider(existing, {
			id: "otherlab",
			baseUrl: "https://api.other.ai/v1",
			apiKeyEnv: "OTHER_API_KEY",
			models: [{ id: "small-1b", contextWindow: 8192 }],
		});
		expect(merged.map((p) => p.id)).toEqual(["mylab", "otherlab"]);
	});

	test("does not mutate the input list", () => {
		const before = JSON.stringify(existing);
		mergeCustomProvider(existing, {
			id: "mylab",
			baseUrl: "https://api2.mylab.ai/v1",
			apiKeyEnv: "MYLAB_API_KEY",
			models: [{ id: "researcher-7b", contextWindow: 65536 }],
		});
		expect(JSON.stringify(existing)).toBe(before);
	});

	test("carries the api protocol and keeps existing apiKeyEnv when the entry omits it (stored-key mode)", () => {
		const merged = mergeCustomProvider(existing, {
			id: "mylab",
			baseUrl: "https://api.mylab.ai/v1",
			api: "openai-responses",
			models: [{ id: "researcher-72b", contextWindow: 131072 }],
		});
		const provider = merged[0];
		expect(provider?.api).toBe("openai-responses");
		expect(provider?.apiKeyEnv).toBe("MYLAB_API_KEY");
		const replaced = mergeCustomProvider(merged, {
			id: "mylab",
			baseUrl: "https://api.mylab.ai/v1",
			apiKeyEnv: "MYLAB_API_KEY_V2",
			models: [{ id: "researcher-72b", contextWindow: 131072 }],
		});
		expect(replaced[0]?.apiKeyEnv).toBe("MYLAB_API_KEY_V2");
	});
});
