import React from 'react';
import ExtensionsSettings from '../ExtensionsSettings.jsx';

export default function RetrievalPane({ data, call }) {
  return <ExtensionsSettings call={call} courses={data.focus?.courses} defaultCourse={data.focus?.course} />;
}
