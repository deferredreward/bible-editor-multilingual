import { useState } from "react";
import { Autocomplete, Chip, TextField, Popper, type PopperProps } from "@mui/material";

interface Props {
  value: string | null;
  options: string[];
  placeholder?: string;
  display?: (value: string | null) => string;
  size?: "small" | "medium";
  color?: "primary" | "default";
  variant?: "filled" | "outlined";
  onChange: (value: string | null) => void;
}

// Show a short-form chip; click to open a dropdown of catalog options with
// typeahead. `display` lets each caller shorten the long value (e.g. drop
// the `rc://*/ta/man/translate/` prefix). `freeSolo` so editors can enter
// values that aren't in the catalog yet.

function FixedWidthPopper(props: PopperProps) {
  return <Popper {...props} style={{ width: 300, zIndex: 1500 }} placement="bottom-start" />;
}

export function CatalogPicker({
  value,
  options,
  placeholder,
  display,
  size = "small",
  color = "default",
  variant = "outlined",
  onChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const shown = display ? display(value) : (value ?? "—");

  if (!open) {
    return (
      <Chip
        label={shown}
        size={size}
        variant={variant}
        color={color}
        onClick={() => setOpen(true)}
        sx={{ cursor: "pointer", fontFamily: "monospace", fontSize: 11, height: 22 }}
      />
    );
  }

  return (
    <Autocomplete<string, false, false, true>
      open
      freeSolo
      autoFocus
      value={value ?? ""}
      options={options}
      PopperComponent={FixedWidthPopper}
      size="small"
      filterOptions={(opts, state) => {
        const q = state.inputValue.toLowerCase().trim();
        if (!q) return opts.slice(0, 50);
        return opts.filter((o) => o.toLowerCase().includes(q)).slice(0, 50);
      }}
      getOptionLabel={(opt) => (display ? display(typeof opt === "string" ? opt : "") : (typeof opt === "string" ? opt : ""))}
      renderOption={(props, opt) => (
        <li {...props} style={{ fontFamily: "monospace", fontSize: 12 }}>
          {display ? display(opt) : opt}
        </li>
      )}
      onChange={(_e, next, reason) => {
        const val = typeof next === "string" ? next : null;
        onChange(val);
        // Clicking the × clears the value but should leave the input
        // open so the user can immediately type a replacement; only
        // close on an actual selection.
        if (val !== null && reason !== "clear") setOpen(false);
      }}
      onClose={(_e, reason) => {
        // MUI's "blur" and "escape" close us; "clear" doesn't (it just
        // fires onChange) but guard anyway. Selecting an option closes.
        if (reason === "blur" || reason === "escape" || reason === "selectOption") {
          setOpen(false);
        }
      }}
      sx={{ minWidth: 260, display: "inline-flex" }}
      renderInput={(params) => (
        <TextField
          {...params}
          autoFocus
          placeholder={placeholder ?? "type to filter…"}
          variant="outlined"
          size="small"
        />
      )}
    />
  );
}
