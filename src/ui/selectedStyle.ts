/**
 * Classes for the selected item of a single-select toggle group.
 *
 * Keyed on `aria-checked`, not `data-state`: inside a tooltip trigger the trigger's own
 * `data-state` (open/closed) replaces the toggle's (on/off), so `data-[state=on]` never
 * matches there, which is why the selected tool looked unselected. The shadcn default
 * (`bg-muted`) also equals the hover style and is nearly invisible in dark mode; the
 * primary color is unmistakable in both themes. `!` makes these win over the base styles.
 */
export const SELECTED_TOGGLE =
  "aria-checked:bg-primary! aria-checked:text-primary-foreground! aria-checked:hover:bg-primary/90! aria-checked:hover:text-primary-foreground!";
