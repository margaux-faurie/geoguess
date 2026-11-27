# Design notes: guessgeo and the Portfolio Design System

## What the client uses from the system

- Tokens: `paper`, `ink`, `ink-muted`, `rule`, `orange`, `second` (navy), `orange-ink`, the radii and spacing, Bricolage Grotesque (`display`, `project`, `lead`, `small`, `label`).
- One large orange surface per screen: the opening panel and the final panel. Everything else on paper.
- Orange for the one thing that matters: the Guess button, the player's pin, the score meter.
- Navy for "here": the answer marker and the stops on the final route list.
- Pills for state (round, points, timer), sentence case, no shadows, no gradients, no icons, no emoji.
- Loading as dots. A link back to the hub, top left, in `small` style.
- Voice: short, plain, no exclamation marks, no selling.

## Places where the system disagrees with itself

1. **Live state colour.** The README says live stops and Live pills are navy (`second`). The StatusPill and RouteLine READMEs say live is orange. The game needs neither, but the hub and the next project will. Pick one.
2. **Motion.** "Never loops on its own except the globe" conflicts with loading dots that pulse. The client pulses the dots only while loading and stops under reduced motion. Decide whether that is allowed.

## Gaps the game had to fill (proposed additions)

| Addition | What the game does now |
| --- | --- |
| Button | Pill, 16px/500. Primary: `orange` with `on-orange` text. On an orange panel: `ink` with `paper` text. Disabled: `rule` outline, `ink-muted` text. Focus: 2px `ink` outline, 2px offset. |
| Field and select | `radius-sm`, 1px `ink` border on orange, `rule` on paper, `label` style above. |
| Meter | The route line as a score bar: 3px, `rule` track, `orange` fill. Reusable for any progress. |
| Result card | `paper`, 1px `rule`, `radius-card`, 24px padding, bottom centre. Title in `project` style. |
| Map style | Land `paper-raised`, water `rule`, borders `ink-faint`, labels `ink-muted`, roads `rule`, no points of interest. As Google Maps JSON in `public/app.js` (`MAP_STYLE`). |
| Markers | Guess: `orange` dot with an `ink` ring. Answer: `second` dot with a `paper` ring. Line between them: `ink`, 2px. |
| Game HUD | Pills in a row, top centre; phones move it below the hub link. |

Nothing here has been written back to the design system. Say the word and I will turn these into components and tokens there.
