import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom({ when }: { when: boolean }) {
  if (when) throw new Error("detail that must not be shown");
  return <p>fine</p>;
}

describe("ErrorBoundary", () => {
  it("shows the fallback, logs only the error name, and shows nothing of the error", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <ErrorBoundary fallback={<p>fallback</p>}>
        <Boom when />
      </ErrorBoundary>,
    );
    expect(screen.getByText("fallback")).toBeTruthy();
    expect(document.body.textContent).not.toContain("detail");
    expect(logged.mock.calls.map((c) => String(c[0]))).toContain("ui render error: Error");
    logged.mockRestore();
  });

  it("clears itself when a reset key changes", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Host() {
      const [key, setKey] = useState("a");
      return (
        <>
          <button type="button" onClick={() => setKey("b")}>
            go
          </button>
          <ErrorBoundary resetKeys={[key]} fallback={<p>fallback</p>}>
            <Boom when={key === "a"} />
          </ErrorBoundary>
        </>
      );
    }
    render(<Host />);
    expect(screen.getByText("fallback")).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "go" }));
    expect(screen.getByText("fine")).toBeTruthy();
    logged.mockRestore();
  });
});
