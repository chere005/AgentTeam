import { useEffect, useState } from "react";
import { agentInitials } from "../agent-identity";

export function AgentAvatar({
  name,
  nickname,
  avatar,
  environment = "codex",
  className = "",
}: {
  name: string;
  nickname?: string | null;
  avatar?: string | null;
  environment?: string;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [avatar]);
  return (
    <span className={className} aria-hidden="true">
      {avatar && !broken ? (
        <img
          className="agent-avatar-image"
          src={avatar}
          alt=""
          onError={() => setBroken(true)}
        />
      ) : (
        agentInitials({ name, nickname })
      )}
    </span>
  );
}
