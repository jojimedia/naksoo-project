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
    <section className="w-full min-w-0 overflow-hidden rounded-xl border border-[#3a3548] bg-[#17151f] shadow-sm [overflow-anchor:none] md:hidden">
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
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-out ${
          shouldShowBody
            ? "grid-rows-[1fr] opacity-100"
            : "grid-rows-[0fr] opacity-0"
        }`}
      >
        <div className="overflow-hidden">{body}</div>
      </div>
    </section>
  );
}
