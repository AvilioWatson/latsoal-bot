---
name: UTBK Content Desk
description: Creative command studio for reliable UTBK content production.
colors:
  ink: "#1E1833"
  paper: "#FFF9F1"
  surface: "#FFFDF8"
  surface-soft: "#F3E9DF"
  violet: "#6947D8"
  violet-hover: "#5435B8"
  coral: "#C84C5C"
  jade: "#216C60"
  text-muted: "#655E6D"
  border: "#D8CCC1"
typography:
  display:
    fontFamily: "Anthropic Sans, Segoe UI, sans-serif"
    fontSize: "32px"
    fontWeight: 700
    lineHeight: 1.1
  body:
    fontFamily: "Anthropic Sans, Segoe UI, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "10px"
  md: "14px"
  lg: "18px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "24px"
components:
  button-primary:
    backgroundColor: "{colors.violet}"
    textColor: "{colors.paper}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
  button-primary-hover:
    backgroundColor: "{colors.violet-hover}"
---

# Design System: UTBK Content Desk

## Overview

**Creative North Star: "The Creative Command Studio"**

UTBK Content Desk is a focused production workspace, not a corporate administration panel. Its visual rhythm should feel energetic and capable: strong typographic hierarchy, selective bursts of violet and coral, and compact motion that makes the work feel responsive.

The system favors clear working surfaces over decorative card grids. It is expressive where actions and progress need energy, and quiet where an operator needs to read, compare, or edit content.

## Colors

Warm paper surfaces keep long review sessions comfortable. Violet carries decisive actions, coral is reserved for warnings and destructive states, and jade confirms success without relying on color alone.

### Primary

- **Command Violet** (#6947D8): primary actions, active controls, and focused workflow moments.
- **Signal Coral** (#C84C5C): destructive actions, high-priority warnings, and review blockers.

### Neutral

- **Studio Ink** (#1E1833): primary text and high-contrast structural elements.
- **Paper Light** (#FFF9F1): application background.
- **Review Surface** (#FFFDF8): readable work surface.
- **Quiet Surface** (#F3E9DF): grouped controls and secondary areas.

**The Accent Has a Job Rule.** Violet and coral communicate action or state. They are never used as arbitrary decoration.

## Typography

**Display Font:** Anthropic Sans, Segoe UI, sans-serif
**Body Font:** Anthropic Sans, Segoe UI, sans-serif
**Label/Mono Font:** Anthropic Mono, Consolas, monospace

**Character:** Direct and contemporary. Titles are assertive; labels remain compact and highly legible.

### Hierarchy

- **Display** (700, 32px, 1.1): page-level purpose and important workspace moments.
- **Headline** (700, 24px, 1.2): panel and workflow headings.
- **Title** (650, 18px, 1.3): cards, groups, and previews.
- **Body** (400, 14px, 1.5): operational information and long-form review content.
- **Label** (650, 12px, 0.06em): compact controls and metadata, never below accessible contrast.

## Elevation

Depth is created primarily through warm tonal layers and borders. Soft shadows appear only when an element is temporarily elevated, such as an active preview, menu, or hoverable action.

## Components

### Buttons

- **Shape:** softly squared, 10px radius.
- **Primary:** Command Violet with Paper Light text.
- **Hover / Focus:** darker violet on hover; 3px high-contrast focus ring on keyboard focus.
- **Secondary:** transparent or Quiet Surface background with Studio Ink text.

### Chips

- **Style:** compact, high-contrast status label with text and icon or explicit wording.
- **State:** selected chips use violet only when they change the active working context.

### Cards / Containers

- **Corner Style:** 14px for panels, 18px for primary preview surfaces.
- **Background:** Review Surface or Quiet Surface, never repeated decorative card grids.
- **Border:** a subtle warm border is the default separator.

### Inputs / Fields

- **Style:** calm surface, visible label, 44px minimum touch height where practical.
- **Focus:** 3px violet focus ring with no reliance on color-only changes.
- **Error / Disabled:** explicit text and state treatment, not opacity alone.

### Navigation

- Use recognizable navigation, clear active state, visible keyboard focus, and a compact mobile treatment.

## Do's and Don'ts

### Do:

- **Do** use violet to mark an action, selection, or workflow transition.
- **Do** preserve 4.5:1 contrast for normal text and 44px touch targets on mobile.
- **Do** use 150 to 250 ms transform and opacity transitions to communicate state.
- **Do** reveal advanced taxonomy controls progressively on narrow screens.

### Don't:

- **Don't** make the interface look overly formal or corporate.
- **Don't** use decorative neon, game-like effects, glassmorphism, or generic hero metric cards.
- **Don't** animate layout properties such as width, height, top, or left.
- **Don't** nest interactive controls inside a clickable card.
