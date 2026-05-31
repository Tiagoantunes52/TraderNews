import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThemeToggle } from "@/components/theme-toggle";

const mockSetTheme = vi.fn();

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: mockSetTheme }),
}));

beforeEach(() => mockSetTheme.mockClear());

describe("ThemeToggle", () => {
  it("renders after mount (no hydration skeleton)", () => {
    render(<ThemeToggle />);
    // After mount the segmented control is visible (sm+ version is in the DOM even if visually hidden)
    expect(screen.getByLabelText("Light theme")).toBeInTheDocument();
    expect(screen.getByLabelText("System theme")).toBeInTheDocument();
    expect(screen.getByLabelText("Dark theme")).toBeInTheDocument();
  });

  it("marks the current theme button as pressed", () => {
    render(<ThemeToggle />);
    expect(screen.getByLabelText("System theme")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Light theme")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByLabelText("Dark theme")).toHaveAttribute("aria-pressed", "false");
  });

  it("calls setTheme when a segment is clicked", () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByLabelText("Dark theme"));
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });

  it("mobile button cycles to the next theme", () => {
    render(<ThemeToggle />);
    // Mobile button: current is "system", next in cycle is "dark"
    const mobileBtn = screen.getByLabelText(/tap for Dark/i);
    fireEvent.click(mobileBtn);
    expect(mockSetTheme).toHaveBeenCalledWith("dark");
  });
});
