# Code Context: pi-glossary Blue Styling

## Summary
The pi-glossary extension applies blue color styling to matched glossary terms using the theme's `"accent"` color throughout the codebase. All instances use the `theme.fg("accent", ...)` or `fullTheme.fg("accent", ...)` methods combined with `bold` formatting.

## Files Retrieved
1. `/Users/ronie/.pi/agent/extensions/pi-glossary/index.ts` (lines 1-750) - Main extension file containing all styling logic

## Key Code: Blue Color Application Points

### 1. **GlossaryOverlay Left Panel Highlighting** (lines 210-220)
Location: `GlossaryOverlay.buildLeftPanel()` method

```typescript
const highlight = (s: string) => this.theme.fg("accent", this.theme.bold(s));
const termText = isSelected
    ? this.theme.fg("accent", this.theme.bold(
        this.query ? highlightMatches(entry.term, this.query, (s) => `\x1b[4m${s}\x1b[24m`) : entry.term,
      ))
    : this.query
    ? highlightMatches(entry.term, this.query, highlight)
    : entry.term;
```
**Purpose**: Highlights matching query terms in the left panel of the glossary overlay (38% width column)
**Styling**: Bold + accent color (blue)

### 2. **GlossaryOverlay Right Panel Term Heading** (line 244)
Location: `GlossaryOverlay.buildRightPanel()` method

```typescript
lines.push(truncateToWidth(" " + this.theme.fg("accent", this.theme.bold(entry.term)), width));
```
**Purpose**: Renders the glossary term name as a heading in the right panel
**Styling**: Bold + accent color (blue)

### 3. **GlossaryOverlay Right Panel Definition Highlighting** (lines 260-265)
Location: `GlossaryOverlay.buildRightPanel()` method

```typescript
const highlight = (s: string) => this.theme.fg("accent", this.theme.bold(s));
const defText = this.query
    ? highlightMatches(entry.definition.trim(), this.query, highlight)
    : entry.definition.trim();
```
**Purpose**: Highlights matching query terms in the definition text (right panel, 62% width column)
**Styling**: Bold + accent color (blue)

### 4. **Editor Component Inline Highlighting** (lines 680-700)
Location: `pi.on("session_start", ...)` event handler, editor component decorator

```typescript
const hl = (s: string) => fullTheme.fg("accent", fullTheme.bold(s));
return lines.map((line) => {
    // ... cursor marker handling ...
    return highlightTermsInAnsiLine(line, activeMatchers, hl);
});
```
**Purpose**: Highlights all active glossary term matches inline in the code editor as the user types
**Styling**: Bold + accent color (blue)

## Architecture

### Color Application Flow
1. **Theme Object**: `ctx.ui.theme` (in editor context) and `this.theme` (in overlay context)
2. **Color Method**: `theme.fg(colorName, text)` applies a foreground color
3. **Formatting**: `theme.bold(text)` adds bold formatting
4. **Combination**: `theme.fg("accent", theme.bold(text))` = bold blue text
5. **Highlight Function**: Each context defines a local `highlight` function that captures the color/bold logic

### Key Functions Involved
- **`highlightMatches(text, query, highlightFn)`** (lines 38-54): Generic case-insensitive text highlighter that calls the passed `highlightFn` on matches
- **`highlightTermsInAnsiLine(line, matchers, highlightFn)`** (lines 59-102): ANSI-aware highlighter that preserves escape sequences while highlighting regex matches
- **`GlossaryOverlay.buildLeftPanel(width)`** (lines 199-231): Renders searchable term list
- **`GlossaryOverlay.buildRightPanel(width)`** (lines 234-267): Renders definition, aliases, and source
- **`session_start` editor decorator** (lines 662-707): Wraps editor with glossary term highlighting during live editing

## Styling Details

### Current Theme Color: "accent"
- **Default Rendering**: Bold blue text (standard "accent" color in most terminal themes)
- **Context**: Works in both the glossary overlay UI and inline editor highlighting
- **Combined with**: `bold` formatting for emphasis

### Available Theme Colors (observed in codebase)
Based on usage throughout the code:
- `"accent"` - Currently used (blue)
- `"muted"` - Disabled/subtle text (gray)
- `"dim"` - Dimmed text
- `"border"` - Border characters
- `"selectedBg"` - Selected background highlight
- `"success"` - Success state (typically green)
- `"error"` or `"warn"` - Error/warning states (typically red)

## Minimal Change Suggestion

To change from blue to a different color, replace **all 4 instances** of `"accent"` with your chosen theme color:

### Option 1: Green (Success Color)
```typescript
// Replace all:
theme.fg("accent",     → theme.fg("success",
fullTheme.fg("accent", → fullTheme.fg("success",
```
**Change Lines**: 213, 215, 244, 262, 683
**Result**: Bold green text for matched terms

### Option 2: Gray/Muted (Subtle Highlight)
```typescript
// Replace all:
theme.fg("accent",     → theme.fg("muted",
fullTheme.fg("accent", → fullTheme.fg("muted",
```
**Change Lines**: 213, 215, 244, 262, 683
**Result**: Bold gray text (less prominent)

### Option 3: Custom Color Name (if supported by theme)
Check with `@mariozechner/pi-tui` documentation for additional color names:
```typescript
theme.fg("custom-color-name", theme.bold(s))
```

### Implementation Pattern
All styling follows the same pattern:
```typescript
const highlight = (s: string) => this.theme.fg("[COLOR_NAME]", this.theme.bold(s));
```

Replace `[COLOR_NAME]` consistently across:
1. Line 213 (left panel highlight function)
2. Line 215 (left panel selected term)
3. Line 244 (right panel heading)
4. Line 262 (right panel definition highlight function)
5. Line 683 (editor inline highlight function)

## Start Here
**`/Users/ronie/.pi/agent/extensions/pi-glossary/index.ts`** - All styling is concentrated in this single file. The 5 locations above are the only places where glossary term colors are defined. No separate CSS or theme files exist for this extension.

To change colors, edit `index.ts` and replace `"accent"` with your preferred theme color name in all 5 locations identified above.
