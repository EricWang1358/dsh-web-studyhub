import React from 'react';
import ScienceSettings from '../ScienceSettings.jsx';

export default function SciencePane({ appearance }) {
  return <ScienceSettings onChange={appearance?.onScience} />;
}
