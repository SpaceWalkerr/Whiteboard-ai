import { Link } from "react-router";

export function InterviewMode() {
  return (
    <>
      <p>
        Interview mode is part of the <Link to="/pricing">Team plan</Link>. It turns a board into a
        live system design round: the candidate draws, interviewers watch, guide and score.
      </p>

      <h2 id="start">Starting an interview</h2>
      <ol>
        <li>
          Open a board and choose <strong>Start interview</strong>.
        </li>
        <li>
          Pick a question from the question bank (it includes hints you can reveal) and set the
          duration.
        </li>
        <li>Share a link with the candidate. Assign roles: interviewer, candidate or observer.</li>
      </ol>

      <h2 id="during">During the interview</h2>
      <ul>
        <li>Everyone sees the question, the revealed hints and the countdown timer.</li>
        <li>Interviewers can pause, resume or extend the timer and reveal hints one by one.</li>
        <li>
          Interviewer notes and the rubric scorecard are private: they never reach the candidate's
          browser.
        </li>
      </ul>

      <h2 id="after">After the interview</h2>
      <ul>
        <li>End the interview to lock the board for the candidate.</li>
        <li>
          Each interviewer submits a scorecard. The summary page collects scores, notes and any AI
          review, and can be exported as a PDF or shared with the hiring panel by link.
        </li>
        <li>
          <strong>Replay</strong> the whole session with a timeline scrubber to see how the design
          evolved.
        </li>
      </ul>

      <h2 id="candidates">Being fair to candidates</h2>
      <p>
        Tell candidates that the session is recorded for replay and how you'll use it, and follow
        your local hiring and data protection rules. See the{" "}
        <Link to="/terms#interviews">Terms</Link>.
      </p>
    </>
  );
}
