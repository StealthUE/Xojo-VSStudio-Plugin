# VS Studio 5000

Open Rockwell **Studio 5000 Logix Designer** projects in VS Code. Every `.ACD` or `.L5X` in the
workspace is decoded into a readable export: one text file per routine (ladder and Structured
Text), a tag cross reference, an execution map, the I/O tree, generated safety checks, and a guide
file so an AI assistant (Claude Code, Cline, Cursor, GitHub Copilot) can work on the logic.

The project file is **never written**. Edited routines are packaged as `.L5X` files that you import
into Studio 5000 yourself.

## What you get

- **Studio 5000 view** in the Explorer, laid out like the Controller Organizer: Tasks, Programs,
  Routines, Add-On Instructions, Data Types, Controller Tags and I/O Configuration. Safety tasks,
  programs and AOIs are marked. Click a routine to open it.
- **Routines as text.** Ladder is shown as `.rll` (Logix neutral text, one rung per line, with rung
  comments). Structured Text is shown as `.st`: the source exactly as written, comments and
  indentation included, **decoded straight from the `.ACD`**, including the ST logic inside AOIs.
  FBD and SFC routines from an `.L5X` are shown as a read-only text view. All have syntax highlighting.
- **Hover** on a tag to see its type, description, safety flag and the member you point at, plus
  where it is written and read.
- **Find Tag Usage** lists every rung and ST line that writes or reads the tag. Pick one to jump to it.
- **Long rungs laid out by branch.** Each branch leg goes on its own line and nested legs are indented,
  so an empty bypass leg is visible as a bare `,` line.
- **AOI-aware cross reference, ladder and ST.** AOI arguments are bound to the AOI's parameters
  (Input, Output or InOut, in their exact definition order). An InOut argument is recorded at the
  members the AOI logic actually writes, whether that logic is ladder or ST.
- **Checks generated from the logic on every export:**

  | File | What it lists |
  |---|---|
  | `SAFETY.md` | Every safety AOI call (E-stop, gate, light curtain, output…): input, where it is mapped, which of its outputs are read and by what, whether they reach an output module or a sink you configure, and whether they are read through a bypassed contact. A device is flagged when none of its outputs is read. Also safety signals written but never read, and read but never produced |
  | `BYPASSES.md` | Empty or NOP-only legs in parallel with contacts (shorts), `AFI()`, and `XIC`/`XIO` of the same bit in series (never true) or in parallel (always true) |
  | `UNCONSUMED.md` | Operand paths written somewhere and read nowhere ("mapped but not consumed") |

  What counts as safety comes only from the project itself, decoded from `.ACD` and `.L5X` alike:
  the safety task and its programs, safety-class AOIs and tags, safety I/O modules and the safety tag
  map. Nothing is inferred from names unless you opt in per project (settings below). CODEBASE.md has
  a *Safety information* table, and anything missing is reported under *Decoder notes*.
- **Command-line lookups** for AI tools. The exact command is written into the guide file:
  `node <extension>/out/cli.js xref <exportDir> Motor1.Run` lists writers and readers with their rung
  or ST line text; `cli.js rung <exportDir> Program/Routine L40` shows an ST line in context.
- **Export docs** for people and AI:

  | File | Contents |
  |---|---|
  | `CODEBASE.md` | Controller, tasks, programs, routines, AOIs, anything not decoded, decoder notes |
  | `PROJECT_MAP.md` | Task → program → main routine → JSR call tree (ladder and ST), and routines that are never called |
  | `CROSSREF.md` → `xref/<scope>.md` | Every tag: each rung / ST line that writes it (instruction, AOI parameter, operand) and each that reads it, one file per scope |
  | `TAGS.md`, `Tags.csv` | Tags by scope, with type, dimensions, flags (safety, produced, consumed, constant), read/write counts and description |
  | `DATATYPES.md`, `AOIS.md` | UDT members and the predefined types in use; AOI parameters, revision, call signature and logic |
  | `MODULES.md` | The I/O tree: modules, catalog numbers, revisions, slots and IP addresses, descriptions, inhibited and safety I/O |
  | `UNUSED.md` | Definitions nothing uses, kept out of the other lists: stale AOI records and unused predefined or module types |

  Locations read `Program/Routine#12` for rung 12 and `Program/Routine#L40` for ST line 40.
- **Edits → L5X.** Change `.rll`/`.st` files, then run **Studio 5000: Build L5X Import from Edits**.
  Each edited routine is checked (ladder: brackets, `;`, known instructions; ST: brackets, comments,
  IF/CASE/FOR/WHILE/REPEAT blocks; both: undefined tags, missing JSR targets) and written to
  `edits/<Program>__<Routine>.L5X`, with an `IMPORT_REPORT.md`. A status bar item counts the edits
  that have not been packaged. Edited files are kept if the project is re-exported.
  **Discard Edits** restores them. An edit means a change in what a routine *says*: its logic,
  comments, ST source or description. Re-layout, blank lines and export-format changes never count,
  so a file can't be flagged by a plugin update. An export folder is locked while it is written,
  so two VS Code windows never write it at once. If an implausible number of files still look
  edited, CODEBASE.md and a notification say so before anything is packaged.
- **Activity log.** Every export (with its reason and duration), decoder note, file written, edit
  detected, packaged or discarded, settings change and file-watcher event (acted on or ignored) is
  recorded with a millisecond timestamp. **Studio 5000: Show Activity Log** (also on the Studio 5000
  view and the project page) opens the *Studio 5000 Activity* output channel and this window's log
  file, which is kept in global storage under `logs/` so it survives a reload and can be attached to
  a bug report.

## Supported input

| | `.ACD` (binary) | `.L5X` (XML export) |
|---|---|---|
| Tasks, programs, schedule, main/fault routine | yes | yes |
| Ladder rungs and rung comments | yes | yes |
| Structured Text (programs and AOIs) | yes | yes |
| FBD / SFC | listed, not decoded | read-only text view |
| Tags, UDTs, descriptions | yes | yes |
| Tag constant, external access, produced / consumed | yes | yes |
| Array sizes (tags, AOI parameters incl. InOut) and UDT `BIT` members with their host | yes | yes |
| Module connection tags (`X:I`, `X:O`, `X:C`) | yes, listed apart | not in an L5X |
| AOI parameters (order, usage, required, types), local tags, revision | yes | yes |
| I/O modules (tree, revision, address, description, inhibited) | yes | yes |
| Module catalog numbers, processor type | yes (see below) | yes |
| Safety task, programs, AOIs, tags, safety I/O, safety tag map | yes | yes |
| Aliases | no | yes |
| Source-protected routines and AOIs | listed | listed with the AOI's parameters |

The ACD decoder has been checked against V31 projects (first created in V28) and against Studio 5000's
own L5X export of the same project. The format is undocumented. Anything the decoder cannot interpret
is reported in `CODEBASE.md` under *Decoder notes* or *Routines not decoded*, and is never silently dropped.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `studio5000.aiTool` | Claude Code | Which AI guide file(s) to write: CLAUDE.md, .clinerules, .cursorrules, copilot-instructions, All or None |
| `studio5000.guardProjectFiles` | true | Add Claude Code deny rules so the AI cannot read the binary `.ACD` |
| `studio5000.autoExport` | true | Export on startup, and re-export when a project file changes |
| `studio5000.exportLocation` | globalStorage | `workspace` writes exports to `.studio5000/` next to the project, so AI tools can read them without leaving the workspace (add the folder to `.gitignore`) |
| `studio5000.safety.namePattern` | off | Opt-in regex: operand names to treat as safety-related without a safety class |
| `studio5000.safety.deviceAoiPattern` | off | Opt-in regex: extra AOIs to treat as safety devices (safety-class AOIs and AOIs called in safety programs always are) |
| `studio5000.safety.sinkPatterns` | off | Opt-in regexes, highest priority first, for what a safety signal must reach besides output modules |
| `studio5000.safety.resultMemberPattern` | off | Opt-in regex for a safety AOI's result member; otherwise a device is judged on all its outputs |
| `studio5000.safety.mappedCopyPattern` | off | Opt-in regex for mapped tags, only for a file without a safety tag map |

The safety rules are off by default because naming conventions differ between integrators: a name
rule would, for example, treat a standard-side AOI with "Safety" in its name as a safety device.
Set them per project (workspace settings) when a site's names are reliable. Changing one regenerates
the checks. Example for a site whose devices write `.S_On` and whose E-stop chain ends in
`Global_EMS` and contactor zones:

```json
"studio5000.safety.resultMemberPattern": "\\.S_On$",
"studio5000.safety.sinkPatterns": ["Global_EMS", "Contactor[^.]*$|Contactor.*\\.S_On$"]
```

Exports live in the extension's global storage (`…/globalStorage/massivedynamicengineering.vs-studio5000/exports/`).
Run **Open Export Folder** to go there.

## How the ACD is decoded

An `.ACD` file has a text save log, then about 25 embedded files, then a directory at the end of the
file. Each directory entry is a 520-byte UTF-16 name followed by a length and an offset. Most embedded
files are gzip streams.

| Embedded file | Used for |
|---|---|
| `QuickInfo.XML`, `TagInfo.XML` | Controller identity, and all tags and data types with their descriptions |
| `Comps.Dat` | Object database: every object's id, parent and name; task, program, AOI and tag attributes (including the safety class, constant and access flags); AOI parameter declarations; I/O modules; and the *Region Map* that gives each routine its rungs in order |
| `SbRegion.Dat` | Rung neutral text, with `@objectid@` references resolved through Comps |
| `RegnLink.Dat` + `Comments.Dat` | Rung comments, and routine and module descriptions |
| `Nameless.Dat` | Structured Text source lines, the stored order of AOI parameters, and the safety tag map |
| `ProjectTemplate.ACD` | The empty template embedded in every project: tells predefined data types from user-defined ones |

Every field listed above was checked against Studio 5000's own L5X export of the same project:
programs, routines, rung text and comments, Structured Text, tags and their flags, AOIs, UDTs,
tasks, modules and the safety tag map all match.

Catalog numbers are not always in an `.ACD`: Studio 5000 looks many of them up in its own device
catalogue by product code. The decoder uses the catalog number where the file stores one, shares it
between modules of the same product, uses a table of known product codes (each verified against a
Studio 5000 L5X export), and otherwise shows the device type and product code (for example
*Programmable Logic Controller (code 147)*). It never guesses.

Old export folders (for projects in other workspaces, or project files since deleted) can be removed
with **Studio 5000: Clean Up Exports**. It lists each folder with its project file and any unpackaged
edits, and deletes only what you select. When stale folders exist (an older export format, or a
project file that no longer exists), the extension says so once per session.

The source lives in `src/acd/`. The open-source [acd-tools](https://github.com/hutcheb/acd) project was
used as a format reference.

## Development

```
npm install
npm test          # compile + tests (generic fixture always; sample projects in Test/ when present)
npm run lint
F5                # launch an Extension Development Host on the Test folder
npm run package   # build a .vsix
```

`src/` layout:

- `acd/`: the container, record databases, object tree, logic, ST source, modules, XML indexes, and the decoder
- `l5x/`: the L5X parser (including the FBD/SFC text view), and the L5X writer and validator
- `export/`: the exporter and docs, the routine file format, ladder and ST analysis, checks, unused definitions, and edits
- `model.ts`: the format-neutral controller model
- `extension.ts`, `tree.ts`, `hover.ts`, `customEditor.ts`, `aiFiles.ts`, `log.ts`, `cli.ts`: the VS Code layer and CLI

## License

MIT, see the LICENSE file. Studio 5000, Logix Designer, RSLogix, ControlLogix and GuardLogix are
trademarks of Rockwell Automation, Inc. This project is not affiliated with Rockwell Automation.
