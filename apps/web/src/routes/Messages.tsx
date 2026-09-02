/**
 * Sending a message to people from the platform.
 *
 * Its own page rather than a dialog: writing to the whole company is a considered act,
 * and a modal encourages treating it as a quick one.
 */
import { MessageComposer } from '../components/MessageComposer';

export default function Messages() {
  return (
    <div className="module-page">
      <header className="module-header">
        <div>
          <h2>Messages</h2>
          <p>Write to a person, a group, a client, or everyone.</p>
        </div>
      </header>
      <MessageComposer />
    </div>
  );
}
