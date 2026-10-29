# Reference contracts and documentation checks

These files make the specification reviewable and checkable before the platform is implemented:

- [contracts.ts](contracts.ts): strict TypeScript interfaces for tasks, gates, providers, plugins, sandboxes, and events.
- [schemas.json](schemas.json): JSON Schema 2020-12 definitions for published payload examples.
- [schema.sql](schema.sql): fresh-install PostgreSQL schema, constraints, and indexes.
- [reference-connectors.ts](reference-connectors.ts): GitHub, Jira, and fake connector logic using the scoped HTTP broker.
- [task-context.example.json](task-context.example.json) and [agent-profile.example.json](agent-profile.example.json): validated payload fixtures.

Image digests, repository names, commit hashes, and model names in examples are illustrative. A future installer must resolve real release artifacts and validate endpoint/model capabilities. The `.example` schema identifier is a stable reference name inside this specification, not a hosted schema service.

## Run the checks

Use Node.js 22 or later and install the locked development tools with `npm ci`. Then run:

```sh
npm run check
npm run check:diagrams
```

`check` lints Markdown, compiles the reference TypeScript under strict settings, validates every JSON/YAML payload example against its assigned schema, checks local links/anchors, executes the DDL in an ephemeral PostgreSQL-compatible PGlite instance, and exercises meaningful invalid-input/database-constraint cases. It also checks the fake connector's operation replay behavior. No task-source or model credentials are used.

`check:diagrams` renders every Mermaid block to SVG using a local Chrome/Chromium/Edge installation. Set `ODA_BROWSER_PATH` if browser discovery does not find your installation. Rendering uses Puppeteer Core and does not download a browser. Generated diagrams and a validation report are written under ignored `.validation/`. The renderer keeps normal browser sandbox settings.

The PostgreSQL check validates fresh-schema execution and representative constraints in embedded PGlite; it does not replace migration tests against the selected production PostgreSQL/Temporal services. The reference connector check uses fake in-memory data; it does not claim the live GitHub/Jira integrations have been exercised.

## Contract maintenance

Update schema, TS declarations, examples, and chapter behavior together. The documentation validator assigns each JSON/YAML fence a schema and fails if a new fence has no assignment. Compile complete reference files; shorter snippets in chapters show their relevant signatures and are not independently executable modules.

Keep accepted/rejected schema fixtures focused on behavior: rejection requires meaningful feedback, approval rejects a reason, profiles reject unknown tools, and missing accounting stays unknown. SQL checks cover duplicate gate decisions, one active run per task, negative usage, and event sequence rollback. Future SDK generation must add parity checks so public types cannot drift from schemas.
