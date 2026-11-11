import { afterEach, expect, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

// findBy*/waitFor default to 1 s, which races on a loaded machine (several agents and a full
// parallel suite). A generous ceiling costs nothing when the element appears quickly.
configure({ asyncUtilTimeout: 8000 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});
