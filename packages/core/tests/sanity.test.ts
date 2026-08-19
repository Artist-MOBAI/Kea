import { expect, test } from "vitest";
import { CORE_VERSION } from "../src/index.ts";

test("workspace wiring: @kea/core sources resolve under vitest/bun", () => {
	expect(CORE_VERSION).toBe("0.1.0");
});
