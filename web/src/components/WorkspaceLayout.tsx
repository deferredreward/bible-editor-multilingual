import { useCallback, useEffect, useRef, type ReactNode } from "react";
import { Box } from "@mui/material";

interface WorkspaceLayoutProps {
  railNode: ReactNode;
  scriptureNode: ReactNode;
  resourcesNode: ReactNode;
  railCollapsed: boolean;
  railWidth: number;
  effectiveSplit: number;
  onSplitRatioChange: (ratio: number) => void;
}

// The fixed 3-region arrangement (Timeline rail · Scripture column · drag
// divider · Resource column), extracted verbatim from Shell. Shell builds the
// three subtrees and hands them in; this component only positions/sizes them
// and owns the divider drag. Split ratio state lives in Shell — the divider
// reports new ratios via onSplitRatioChange.
export function WorkspaceLayout({
  railNode,
  scriptureNode,
  resourcesNode,
  railCollapsed,
  railWidth,
  effectiveSplit,
  onSplitRatioChange,
}: WorkspaceLayoutProps) {
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  useEffect(() => () => { document.body.style.cursor = ""; document.body.style.userSelect = ""; }, []);
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingRef.current = true;
    document.body.style.cursor = "ew-resize";
    document.body.style.userSelect = "none";
    const onMouseMove = (ev: MouseEvent) => {
      if (!isDraggingRef.current || !splitContainerRef.current) return;
      const rect = splitContainerRef.current.getBoundingClientRect();
      const available = rect.width - railWidth;
      const offset = ev.clientX - rect.left - railWidth;
      onSplitRatioChange(Math.min(0.8, Math.max(0.2, offset / available)));
    };
    const onMouseUp = () => {
      isDraggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [railWidth, onSplitRatioChange]);

  return (
    <Box ref={splitContainerRef} sx={{ flex: 1, display: "flex", overflow: "hidden" }}>
      {!railCollapsed && (
        <Box sx={{ width: railWidth, flexShrink: 0, minHeight: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {railNode}
        </Box>
      )}
      <Box
        sx={{
          width: `${effectiveSplit * 100}%`,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {scriptureNode}
      </Box>
      <Box
        onMouseDown={handleDividerMouseDown}
        sx={{
          width: "8px",
          flexShrink: 0,
          cursor: "ew-resize",
          position: "relative",
          "&::after": {
            content: '""',
            position: "absolute",
            left: "50%",
            top: 0,
            bottom: 0,
            width: "1px",
            bgcolor: "divider",
            transform: "translateX(-50%)",
            transition: "background-color 0.15s",
          },
          "&:hover::after": { bgcolor: "primary.main" },
        }}
      />
      <Box
        sx={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {resourcesNode}
      </Box>
    </Box>
  );
}
