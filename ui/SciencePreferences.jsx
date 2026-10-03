import React from 'react';
import { SCIENCE_DEFAULTS } from './science-settings.js';
export const SciencePreferencesContext = React.createContext(SCIENCE_DEFAULTS);
export const useSciencePreferences = () => React.useContext(SciencePreferencesContext);

