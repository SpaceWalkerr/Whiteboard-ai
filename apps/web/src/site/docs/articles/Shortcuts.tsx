import { SHORTCUTS, type Shortcut } from "@/features/board/keyboard/shortcuts";

const GROUPS: readonly Shortcut["group"][] = ["Tools", "Edit", "Arrange", "View", "Review"];

/** "Mod" is ⌘ on macOS and Ctrl elsewhere; the page is the same for everyone. */
function keyLabel(key: string): string {
  return key === "Mod" ? "Ctrl/⌘" : key;
}

/** Generated from the board's own shortcut table, so it can't drift from the app. */
export function Shortcuts() {
  return (
    <>
      <p>
        Press <kbd>?</kbd> on any board to see this list. On macOS use <kbd>⌘</kbd> where it says
        Ctrl/⌘; elsewhere use <kbd>Ctrl</kbd>.
      </p>
      {GROUPS.map((group) => (
        <section key={group} aria-labelledby={`shortcuts-${group}`}>
          <h2 id={`shortcuts-${group}`}>{group}</h2>
          <table>
            <thead>
              <tr>
                <th scope="col">Action</th>
                <th scope="col">Keys</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.filter((s) => s.group === group).map((shortcut) => (
                <tr key={shortcut.description}>
                  <td>{shortcut.description}</td>
                  <td>
                    {shortcut.keys.map((key, i) => (
                      <span key={key}>
                        {i > 0 && " + "}
                        <kbd>{keyLabel(key)}</kbd>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
