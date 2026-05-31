import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewsFilterBar } from "@/app/(dashboard)/dashboard/news/news-filter-bar";

const mockPush = vi.fn();
const mockReplace = vi.fn();

let mockParams = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => "/dashboard/news",
  useSearchParams: () => mockParams,
}));

beforeEach(() => {
  mockPush.mockClear();
  mockReplace.mockClear();
  mockParams = new URLSearchParams();
});

describe("NewsFilterBar", () => {
  it("renders search input and filter chips", () => {
    render(<NewsFilterBar tickers={[]} />);
    expect(screen.getByPlaceholderText("Search headlines...")).toBeInTheDocument();
    expect(screen.getByText("All time")).toBeInTheDocument();
    expect(screen.getByText("24h")).toBeInTheDocument();
    expect(screen.getByText("Bullish 📈")).toBeInTheDocument();
  });

  it("renders ticker chips when tickers are provided", () => {
    render(<NewsFilterBar tickers={["AAPL", "TSLA"]} />);
    expect(screen.getByText("AAPL")).toBeInTheDocument();
    expect(screen.getByText("TSLA")).toBeInTheDocument();
  });

  it("does not show ticker section when tickers list is empty", () => {
    render(<NewsFilterBar tickers={[]} />);
    expect(screen.queryByText("AAPL")).not.toBeInTheDocument();
  });

  it("calls router.push with time param when time chip is clicked", () => {
    render(<NewsFilterBar tickers={[]} />);
    fireEvent.click(screen.getByText("24h"));
    expect(mockPush).toHaveBeenCalledWith("/dashboard/news?time=24h");
  });

  it("calls router.push with mood param when mood chip is clicked", () => {
    render(<NewsFilterBar tickers={[]} />);
    fireEvent.click(screen.getByText("Bullish 📈"));
    expect(mockPush).toHaveBeenCalledWith("/dashboard/news?mood=bull");
  });

  it("does not show clear filters button when no filters are active", () => {
    render(<NewsFilterBar tickers={[]} />);
    expect(screen.queryByText("Clear filters")).not.toBeInTheDocument();
  });

  it("shows clear filters button when a filter is active", () => {
    mockParams = new URLSearchParams("time=24h");
    render(<NewsFilterBar tickers={[]} />);
    expect(screen.getByText("Clear filters")).toBeInTheDocument();
  });

  it("clears all filters on clear button click", () => {
    mockParams = new URLSearchParams("time=24h&mood=bull");
    render(<NewsFilterBar tickers={[]} />);
    fireEvent.click(screen.getByText("Clear filters"));
    expect(mockPush).toHaveBeenCalledWith("/dashboard/news");
  });
});
