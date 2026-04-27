"use client";

import { useState } from "react";

type MobileCrewCardProps = {
  header: React.ReactNode;
  body: React.ReactNode;
};

export default function MobileCrewCard({ header, body }: MobileCrewCardProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <section className="overflow-hidden rounded-[28px] bg-slate-950 shadow-2xl shadow-black/30 backdrop-blur-xl md:hidden">
      <button
        type="button"
        className="block w-full cursor-pointer text-left [-webkit-tap-highlight-color:transparent]"
        onClick={() => setIsOpen((current) => !current)}
      >
        {header}
      </button>
      {isOpen ? body : null}
    </section>
  );
}
