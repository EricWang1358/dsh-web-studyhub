import React, { useEffect, useState } from 'react';
import ExtensionsSettings from '../ExtensionsSettings.jsx';
import { clearIndexCourse, peekIndexCourse } from '../index-focus.js';

export default function RetrievalPane({ data, call }) {
  // A material's 建立索引 link names its course; the section opens with that course chosen (else the current one).
  const [asked] = useState(peekIndexCourse);
  useEffect(() => { clearIndexCourse(); }, []);
  return <ExtensionsSettings call={call} courses={data.focus?.courses} defaultCourse={asked || data.focus?.course} />;
}
