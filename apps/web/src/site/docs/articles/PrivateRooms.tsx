import { Link } from "react-router";

export function PrivateRooms() {
  return (
    <>
      <p>
        Private rooms (Pro and Team) are boards encrypted end to end. Your browser encrypts every
        change before it leaves your device; our servers store and relay only data they can't read.
      </p>

      <h2 id="key">The key is in the link</h2>
      <ul>
        <li>
          When you create a private board your browser makes a random key and puts it in the link,
          after the <code>#</code>. Browsers never send that part of a URL to servers.
        </li>
        <li>Anyone with the full link (and access to the board) can decrypt it.</li>
        <li>
          <strong>
            If you lose every copy of the link, nobody — including us — can recover the board.
          </strong>{" "}
          Keep it somewhere safe, like a password manager.
        </li>
        <li>
          Your devices remember keys of private boards you've opened, so the dashboard can show
          their titles. Signing out deletes those keys from the device (we warn you first).
        </li>
      </ul>

      <h2 id="limits">What works differently</h2>
      <ul>
        <li>
          No dashboard thumbnails and no duplication — the server can't read the content to make
          them.
        </li>
        <li>
          AI review needs your explicit consent each time, and sends only the extracted graph of the
          diagram for that review.
        </li>
        <li>
          Removing someone stops their access, but they may have kept the key: for sensitive
          content, move it to a new private board.
        </li>
      </ul>

      <p>
        See <Link to="/docs/sharing-and-permissions">Sharing and permissions</Link> and the{" "}
        <Link to="/privacy">Privacy Policy</Link>.
      </p>
    </>
  );
}
