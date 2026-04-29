"use client";

import Image from "next/image";
import { useState } from "react";

const PROFILE_FALLBACK_URL =
  "https://res.sooplive.com/images/svg/thumb_profile.svg";

type Fan = {
  rank: number;
  user_id: string;
  nickname: string;
  balloons: number;
};

type CrewMember = {
  rank: number;
  user_id: string;
  nickname: string;
  profile_image_url: string;
  current_balloons: number;
  previous_balloons: number;
  change_balloons: number;
  change_rate: number;
  display_day_balloons: number;
  monthly_top_fans: Fan[];
};

function formatNumber(value: number) {
  return new Intl.NumberFormat("ko-KR").format(value);
}

function formatSignedPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function ProfileImage({ member }: { member: CrewMember }) {
  const [src, setSrc] = useState(member.profile_image_url);

  return (
    <Image
      src={src}
      alt=""
      width={48}
      height={48}
      unoptimized
      onError={() => setSrc(PROFILE_FALLBACK_URL)}
      className="h-10 w-10 rounded-full border border-white/10 bg-slate-800 object-cover xl:h-10 xl:w-10 min-[1800px]:h-11 min-[1800px]:w-11"
    />
  );
}

function FanRanking({ fans }: { fans: Fan[] }) {
  return (
    <div className="mx-1 mb-3 rounded-2xl border border-white/[0.07] bg-slate-900/80 px-3 py-3 shadow-inner shadow-black/25">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-black text-slate-100">이달의 후원자</p>
        <p className="text-xs font-bold text-slate-500">TOP 10</p>
      </div>

      {fans.length > 0 ? (
        <div className="space-y-1.5">
          {fans.map((fan) => (
            <div
              key={`${fan.rank}-${fan.user_id}`}
              className="grid min-h-9 grid-cols-[34px_minmax(0,1fr)_104px] items-center gap-2 rounded-xl bg-white/[0.035] px-2.5 py-1.5"
            >
              <p className="text-center text-sm font-black tabular-nums text-slate-500">
                {fan.rank}
              </p>
              <p className="min-w-0 truncate text-[15px] font-extrabold text-slate-100">
                {fan.nickname}
              </p>
              <p className="text-right text-[15px] font-black tabular-nums text-amber-300">
                {formatNumber(fan.balloons)}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-xl bg-white/[0.035] px-3 py-3 text-center text-sm font-bold text-slate-500">
          후원자 데이터 없음
        </p>
      )}
    </div>
  );
}

export default function StreamerMemberRow({
  member,
}: {
  member: CrewMember;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const changeColor =
    member.change_balloons >= 0 ? "text-emerald-300" : "text-rose-300";

  return (
    <div className="border-t border-white/[0.04]">
      <div className="grid min-h-[74px] grid-cols-[24px_40px_minmax(0,1fr)_112px] grid-rows-[16px_26px_17px] items-center gap-x-2 gap-y-1 px-1 py-2.5 md:grid-cols-[24px_40px_minmax(0,1fr)_106px] lg:grid-cols-[24px_40px_minmax(0,1fr)_104px] xl:grid-cols-[24px_40px_minmax(0,1fr)_108px] 2xl:grid-cols-[26px_42px_minmax(0,1fr)_120px] min-[1800px]:grid-cols-[30px_46px_minmax(0,1fr)_136px]">
        <p className="row-span-2 row-start-2 self-center text-center text-[16px] font-black leading-none tabular-nums text-slate-500 xl:text-[16px] min-[1800px]:text-[17px]">
          {member.rank}
        </p>
        <div className="row-span-2 row-start-2 self-center">
          <ProfileImage member={member} />
        </div>

        <p
          className={`col-start-4 row-start-1 self-end text-right text-[14px] font-black leading-none tabular-nums xl:text-[15px] 2xl:text-[15px] min-[1800px]:text-[16px] ${changeColor}`}
        >
          {formatSignedPercent(member.change_rate)}
        </p>

        <button
          type="button"
          className="col-start-3 row-start-2 block min-w-0 cursor-pointer truncate text-left text-[18px] font-extrabold leading-none text-slate-100 hover:text-amber-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 xl:text-[19px] 2xl:text-[19px] min-[1800px]:text-[22px]"
          aria-expanded={isOpen}
          aria-label={`${member.nickname} 이달의 후원자 ${isOpen ? "접기" : "열기"}`}
          onClick={() => setIsOpen((current) => !current)}
        >
          {member.nickname}
        </button>
        <p className="col-start-4 row-start-2 text-right text-[20px] font-black leading-none whitespace-nowrap tabular-nums text-sky-300 xl:text-[21px] 2xl:text-[22px] min-[1800px]:text-[26px]">
          {formatNumber(member.current_balloons)}
        </p>

        <p className="col-start-3 row-start-3 truncate text-[14px] font-extrabold leading-none tabular-nums text-sky-200 xl:text-[15px] min-[1800px]:text-[16px]">
          {formatNumber(member.display_day_balloons)}
        </p>
        <p className="col-start-4 row-start-3 truncate text-right text-[13px] font-extrabold leading-none whitespace-nowrap tabular-nums text-slate-400 xl:text-[14px] min-[1800px]:text-[15px]">
          지난 달 {formatNumber(member.previous_balloons)}
        </p>
      </div>

      {isOpen ? <FanRanking fans={member.monthly_top_fans} /> : null}
    </div>
  );
}
