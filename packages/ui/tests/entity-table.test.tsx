import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityTable, type EntityTableColumn } from "../src/entity-table";

/**
 * Milestone 2.1G-A. No jsdom/@testing-library/happy-dom exist anywhere in
 * this repository's dependency tree (verified during the 2.1G audit), so
 * these tests use `react-dom/server`'s `renderToStaticMarkup` — already
 * bundled with `react-dom`, which this package needs regardless, so this
 * adds zero new dependencies. This proves real React rendering output
 * (structure, text content, attributes, conditional branches) for every
 * state, but CANNOT verify that a rendered <button>'s click handler
 * actually fires on a real click — that requires a DOM event system
 * (jsdom/happy-dom), which does not exist here. That specific gap
 * (`onLoadMore` firing on click) is explicitly NOT covered below; it is
 * called out in the implementation report as a testing limitation rather
 * than silently skipped or worked around with a new dependency.
 */

interface Row {
  id: string;
  name: string;
}

const rows: Row[] = [
  { id: "a", name: "Acme" },
  { id: "b", name: "Beta" },
];

const columns: EntityTableColumn<Row>[] = [{ key: "name", header: "Name", render: (row) => row.name }];

function renderTable(props: Partial<React.ComponentProps<typeof EntityTable<Row>>> = {}): string {
  return renderToStaticMarkup(
    <EntityTable columns={columns} rows={rows} getRowId={(row) => row.id} {...props} />,
  );
}

describe("EntityTable: ready state", () => {
  it("renders a semantic table with headers and one row per item, keyed by getRowId", () => {
    const html = renderTable();
    expect(html).toContain("<table");
    expect(html).toContain("Name");
    expect(html).toContain("Acme");
    expect(html).toContain("Beta");
    expect(html).toContain('data-row-id="a"');
    expect(html).toContain('data-row-id="b"');
  });

  it("renders each column via its own render() function, not a generic field lookup", () => {
    const customColumns: EntityTableColumn<Row>[] = [
      { key: "name", header: "Name", render: (row) => `Company: ${row.name}` },
    ];
    const html = renderToStaticMarkup(
      <EntityTable columns={customColumns} rows={rows} getRowId={(row) => row.id} />,
    );
    expect(html).toContain("Company: Acme");
    expect(html).toContain("Company: Beta");
  });

  it("omits the actions column entirely when rowActions is not provided", () => {
    const html = renderTable();
    expect(html).not.toContain("Actions");
  });

  it("renders a row action per row when rowActions is provided", () => {
    const html = renderTable({ rowActions: (row) => <a href={`/companies/${row.id}`}>Edit</a> });
    expect(html).toContain('href="/companies/a"');
    expect(html).toContain('href="/companies/b"');
  });
});

describe("EntityTable: empty state", () => {
  it("renders the empty message and no data rows, given zero rows", () => {
    const html = renderToStaticMarkup(
      <EntityTable columns={columns} rows={[]} getRowId={(row) => row.id} state="empty" />,
    );
    expect(html).toContain("No items found.");
    expect(html).not.toContain("data-row-id");
  });

  it("also treats a zero-length rows array as empty even without an explicit state prop", () => {
    const html = renderToStaticMarkup(<EntityTable columns={columns} rows={[]} getRowId={(row) => row.id} />);
    expect(html).toContain("No items found.");
  });

  it("supports a custom empty message", () => {
    const html = renderToStaticMarkup(
      <EntityTable
        columns={columns}
        rows={[]}
        getRowId={(row) => row.id}
        state="empty"
        emptyMessage="No companies yet."
      />,
    );
    expect(html).toContain("No companies yet.");
  });
});

describe("EntityTable: loading state", () => {
  it("renders an accessible loading placeholder and no data rows", () => {
    const html = renderTable({ state: "loading" });
    expect(html).toContain("Loading…");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("data-row-id");
  });

  it("marks the table aria-busy while in the loading state", () => {
    const html = renderTable({ state: "loading" });
    expect(html).toContain('aria-busy="true"');
  });

  it("does not mark the table aria-busy in the ready state", () => {
    const html = renderTable({ state: "ready" });
    expect(html).toContain('aria-busy="false"');
  });
});

describe("EntityTable: error state", () => {
  it("renders an accessible error message and no table underneath it", () => {
    const html = renderTable({ state: "error" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
    expect(html).not.toContain("<table");
  });

  it("supports a custom error message", () => {
    const html = renderTable({ state: "error", errorMessage: "Failed to load companies." });
    expect(html).toContain("Failed to load companies.");
  });

  it("never renders row data underneath an error state, even if rows were passed", () => {
    const html = renderTable({ state: "error" });
    expect(html).not.toContain("Acme");
  });
});

describe("EntityTable: pagination", () => {
  it("does not render a Load More button when hasMore is false and not loading", () => {
    const html = renderTable({ onLoadMore: vi.fn(), hasMore: false, isLoadingMore: false });
    expect(html).not.toContain("Load more");
    expect(html).not.toContain("<button");
  });

  it("does not render a Load More button at all when onLoadMore is not provided, even if hasMore is true", () => {
    const html = renderTable({ hasMore: true });
    expect(html).not.toContain("<button");
  });

  it("renders a real, enabled button when hasMore is true", () => {
    const html = renderTable({ onLoadMore: vi.fn(), hasMore: true });
    expect(html).toContain("<button");
    expect(html).toContain("Load more");
    expect(html).not.toContain('disabled=""');
    expect(html).toContain('aria-disabled="false"');
  });

  it("supports a custom load-more label", () => {
    const html = renderTable({ onLoadMore: vi.fn(), hasMore: true, loadMoreLabel: "Show more companies" });
    expect(html).toContain("Show more companies");
  });

  it("disables the button and shows a loading label while isLoadingMore is true", () => {
    const html = renderTable({ onLoadMore: vi.fn(), hasMore: true, isLoadingMore: true });
    expect(html).toContain("disabled=\"\"");
    expect(html).toContain("Loading…");
  });

  it("still renders the (disabled) button while isLoadingMore is true even if hasMore has already flipped to false", () => {
    const html = renderTable({ onLoadMore: vi.fn(), hasMore: false, isLoadingMore: true });
    expect(html).toContain("<button");
  });
});

describe("EntityTable: public API stability", () => {
  it("is generic over an arbitrary row shape", () => {
    interface OtherRow {
      uuid: string;
      label: string;
    }
    const otherColumns: EntityTableColumn<OtherRow>[] = [{ key: "label", header: "Label", render: (r) => r.label }];
    const html = renderToStaticMarkup(
      <EntityTable
        columns={otherColumns}
        rows={[{ uuid: "1", label: "X" }]}
        getRowId={(r) => r.uuid}
      />,
    );
    expect(html).toContain("X");
  });

  it("defaults to the ready state when no state prop is given and rows are present", () => {
    const html = renderTable();
    expect(html).toContain("Acme");
  });
});
