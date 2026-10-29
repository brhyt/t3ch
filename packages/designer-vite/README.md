# T3CH Designer for React/Vite

Add `t3chDesigner()` before other plugins in your Vite configuration, then restart the development server. During local testing, import it from this package's `index.mjs` file. The package is not published yet.

Open the development page in T3CH's Browser panel from a thread whose workspace contains the project, enable Design, and select an element. Changes update its JSX style attribute and affect every rendered instance of that source element. Conditional and generated text remain controlled by the application; use Annotate to request changes to those expressions.

The plugin runs only in development. It adds source references to native JSX elements without modifying project source files or production output. Designer verifies the source revision before saving. If another editor changed the file, let hot reload finish and select the element again.

This version writes literal JSX style overrides. It does not rewrite Tailwind classes, stylesheets, dynamic style objects, or spread props. Undo and Redo operate through T3CH's source history.
