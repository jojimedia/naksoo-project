"use client";

import { useState } from "react";

type MobileCrewCardProps = {
  header: React.ReactNode;
  body: React.ReactNode;
  forceOpen?: boolean;
};

export default function MobileCrewCard({
  header,
  body,
  forceOpen = false,
}: MobileCrewCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const shouldShowBody = forceOpen || isOpen;

  return (
    <section className="w-full min-w-0 overflow-hidden rounded-xl border border-[#c7c4d6] bg-white shadow-sm [overflow-anchor:none] md:hidden">
      <button
        type="button"
        className="block w-full cursor-pointer text-left [-webkit-tap-highlight-color:transparent]"
        aria-expanded={shouldShowBody}
        onClick={() => {
          if (!forceOpen) {
            setIsOpen((current) => !current);
          }
        }}
      >
        {header}
      </button>
      <div className={shouldShowBody ? "block" : "hidden"}>{body}</div>
    </section>
  );
}
