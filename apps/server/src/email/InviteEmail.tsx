import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Preview,
  render,
  Text,
} from "@react-email/components";
import type { EmailMessage } from "./mailer";

interface InviteEmailProps {
  inviterName: string;
  boardTitle: string;
  role: "editor" | "viewer";
  acceptUrl: string;
}

function InviteEmail({ inviterName, boardTitle, role, acceptUrl }: InviteEmailProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{`${inviterName} invited you to "${boardTitle}" on Whiteboard.ai`}</Preview>
      <Body
        style={{
          backgroundColor: "#f3f4f6",
          fontFamily: "Inter, Arial, sans-serif",
          padding: "24px 0",
        }}
      >
        <Container
          style={{ backgroundColor: "#ffffff", borderRadius: 8, padding: 32, maxWidth: 480 }}
        >
          <Heading as="h1" style={{ fontSize: 20, color: "#111827" }}>
            You're invited to a board
          </Heading>
          <Text style={{ color: "#374151", fontSize: 15 }}>
            {inviterName} invited you to {role === "editor" ? "edit" : "view"}{" "}
            <strong>{boardTitle}</strong> on Whiteboard.ai.
          </Text>
          <Button
            href={acceptUrl}
            style={{
              backgroundColor: "#111827",
              color: "#ffffff",
              borderRadius: 6,
              padding: "12px 20px",
              fontSize: 15,
            }}
          >
            Open the board
          </Button>
          <Hr style={{ margin: "24px 0", borderColor: "#e5e7eb" }} />
          <Text style={{ color: "#6b7280", fontSize: 13 }}>
            Sign in with this email address to accept. The invite expires in 14 days. If you weren't
            expecting it, you can ignore this email.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export async function inviteEmail(to: string, props: InviteEmailProps): Promise<EmailMessage> {
  const element = <InviteEmail {...props} />;
  return {
    to,
    subject: `${props.inviterName} invited you to "${props.boardTitle}"`,
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}
