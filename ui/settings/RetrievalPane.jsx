import React from 'react';
import ExtensionsSettings from '../ExtensionsSettings.jsx';

export default function RetrievalPane({ data, call, setNotice }) {
  return <ExtensionsSettings call={call} setNotice={setNotice} courses={data.focus?.courses} defaultCourse={data.focus?.course} />;
}
