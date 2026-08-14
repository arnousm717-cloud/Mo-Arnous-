import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PipelineBoard, type PipelineBoardStage } from "../src/pipeline-board";

/**
 * Milestone 2.2F. Same renderToStaticMarkup discipline as
 * entity-table.test.tsx — no jsdom/@testing-library exist in this
 * repository's dependency tree, so these tests prove real React
 * rendering output (structure, text content, conditional branches) for
 * every state, but CANNOT prove that a rendered moveControl's own click/
 * submit interaction actually fires, and CANNOT prove drag-and-drop
 * (not implemented at all — see ../src/pipeline-board.tsx's own
 * comment). Both gaps are testing limitations, not silently skipped.
 */

const stages: PipelineBoardStage[] = [
  {
    id: "stage-1",
    name: "Qualifying",
    cards: [
      { id: "deal-1", label: "Acme Co", amountLabel: "500 EUR" },
      { id: "deal-2", label: "Beta Inc" },
    ],
  },
  {
    id: "stage-2",
    name: "Won",
    cards: [],
  },
];

describe("PipelineBoard: ready state", () => {
  it("renders one column per stage, in the given order", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} />);
    const qualifyingIndex = html.indexOf("Qualifying");
    const wonIndex = html.indexOf("Won");
    expect(qualifyingIndex).toBeGreaterThan(-1);
    expect(wonIndex).toBeGreaterThan(-1);
    expect(qualifyingIndex).toBeLessThan(wonIndex);
  });

  it("groups cards under their own stage's column, not mixed together", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} />);
    expect(html).toContain("Acme Co");
    expect(html).toContain("Beta Inc");
  });

  it("renders a card's pre-formatted amount label as-is, doing no formatting itself", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} />);
    expect(html).toContain("500 EUR");
  });

  it("renders an empty stage column with its own empty message, not as a board-level empty state", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} />);
    expect(html).toContain("No deals in this stage.");
    expect(html).toContain("Won");
  });

  it("supports a custom empty-stage message", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} emptyStageMessage="Nothing here yet." />);
    expect(html).toContain("Nothing here yet.");
  });

  it("shows a card count per column", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} />);
    expect(html).toContain("(2)");
    expect(html).toContain("(0)");
  });

  it("never renders a raw card id as its own label — the caller-supplied safe label is used as-is", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} />);
    expect(html).not.toContain("deal-1");
    expect(html).not.toContain("deal-2");
  });

  it("renders the caller-supplied moveControl node inside the card", () => {
    const withMove: PipelineBoardStage[] = [
      { id: "stage-1", name: "Qualifying", cards: [{ id: "deal-1", label: "Acme Co", moveControl: <button type="button">Move</button> }] },
    ];
    const html = renderToStaticMarkup(<PipelineBoard stages={withMove} />);
    expect(html).toContain("<button");
    expect(html).toContain("Move</button>");
  });

  it("omits the move-control slot entirely when moveControl is not provided — absent, not merely disabled", () => {
    const readOnly: PipelineBoardStage[] = [{ id: "stage-1", name: "Qualifying", cards: [{ id: "deal-1", label: "Acme Co" }] }];
    const html = renderToStaticMarkup(<PipelineBoard stages={readOnly} />);
    expect(html).not.toContain("<button");
  });

  it("defaults to the ready state when no state prop is given and stages are present", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} />);
    expect(html).toContain("Acme Co");
  });
});

describe("PipelineBoard: empty state", () => {
  it("renders the empty message and no columns when state is explicitly empty", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} state="empty" />);
    expect(html).toContain("No stages to show.");
    expect(html).not.toContain("Acme Co");
  });

  it("also treats a zero-length stages array as empty even without an explicit state prop", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={[]} />);
    expect(html).toContain("No stages to show.");
  });

  it("supports a custom empty message", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={[]} emptyMessage="No active pipeline yet." />);
    expect(html).toContain("No active pipeline yet.");
  });
});

describe("PipelineBoard: loading state", () => {
  it("renders an accessible loading placeholder and no columns", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} state="loading" />);
    expect(html).toContain("Loading…");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("Acme Co");
  });
});

describe("PipelineBoard: error state", () => {
  it("renders an accessible error message and no board underneath it", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} state="error" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("Acme Co");
  });

  it("supports a custom error message", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} state="error" errorMessage="Failed to load the board." />);
    expect(html).toContain("Failed to load the board.");
  });

  it("never renders stale card data underneath an error state, even if stages were passed", () => {
    const html = renderToStaticMarkup(<PipelineBoard stages={stages} state="error" />);
    expect(html).not.toContain("Beta Inc");
  });
});

describe("PipelineBoard: public API stability", () => {
  it("accepts a contextLabel alongside a label without requiring it", () => {
    const withContext: PipelineBoardStage[] = [
      { id: "stage-1", name: "Qualifying", cards: [{ id: "deal-1", label: "Acme Co", contextLabel: "Ada Lovelace" }] },
    ];
    const html = renderToStaticMarkup(<PipelineBoard stages={withContext} />);
    expect(html).toContain("Ada Lovelace");
  });
});
