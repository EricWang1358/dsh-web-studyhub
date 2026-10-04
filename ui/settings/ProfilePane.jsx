import React from 'react';
import { CoachSection } from './CoachSection.jsx';
import { OnboardingControls } from '../app/SettingsPanels.jsx';

/** 学习画像与导览: the sample and tour controls, then the coach profile once it has loaded. */
export default function ProfilePane({ profile, setProfile, busy, act, call, setNotice }) {
  return <>
    <OnboardingControls />
    {profile && <CoachSection profile={profile} busy={busy} act={act} call={call} setProfile={setProfile} setNotice={setNotice} />}
  </>;
}
