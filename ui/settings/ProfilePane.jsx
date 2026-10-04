import React from 'react';
import { CoachSection } from './CoachSection.jsx';

/** 学习画像与导览: the sample and tour controls the app hands in as `onboardingPanel`, then the coach profile once it has loaded. */
export default function ProfilePane({ onboardingPanel, profile, setProfile, busy, act, call, setNotice }) {
  return <>
    {onboardingPanel}
    {profile && <CoachSection profile={profile} busy={busy} act={act} call={call} setProfile={setProfile} setNotice={setNotice} />}
  </>;
}
