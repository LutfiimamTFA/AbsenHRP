'use server';
/**
 * @fileOverview This flow generates a clear, concise, and context-aware explanation for attendance anomalies,
 * explaining why a special action (like a selfie) is required and how to address it.
 *
 * - explainAttendanceAnomaly - A function that handles the anomaly explanation process.
 * - AttendanceAnomalyInput - The input type for the explainAttendanceAnomaly function.
 * - AttendanceAnomalyOutput - The return type for the explainAttendanceAnomaly function.
 */

import {ai} from '@/ai/genkit';
import {z} from 'genkit';

const AttendanceAnomalyInputSchema = z.object({
  accuracyM: z.number().describe('The current GPS accuracy in meters.'),
  distanceToBoundaryM: z.number().nullable().describe('The distance to the nearest work location boundary in meters. Null if not applicable.'),
  isNewDevice: z.boolean().describe('True if the user is using a new or unrecognized device.'),
  mode: z.enum(['ONSITE', 'OFFSITE']).describe('The attendance mode, either "ONSITE" or "OFFSITE".'),
  workLocationName: z.string().optional().describe('The name of the detected work location, if applicable.'),
  userName: z.string().describe('The name of the user.'),
});
export type AttendanceAnomalyInput = z.infer<typeof AttendanceAnomalyInputSchema>;

const AttendanceAnomalyOutputSchema = z.object({
  explanation: z.string().describe('A clear, concise, and context-aware explanation for the attendance anomaly and why a selfie is required.'),
  actionRequired: z.literal('selfie').describe('The action required from the user, which is always "selfie" for these anomalies.'),
});
export type AttendanceAnomalyOutput = z.infer<typeof AttendanceAnomalyOutputSchema>;

const explainAttendanceAnomalyPrompt = ai.definePrompt({
  name: 'explainAttendanceAnomalyPrompt',
  input: {schema: AttendanceAnomalyInputSchema},
  output: {schema: AttendanceAnomalyOutputSchema},
  prompt: `You are an attendance system assistant providing clear and concise explanations for attendance anomalies.
Based on the provided attendance data for user "{{{userName}}}", you need to explain why an anomaly was detected and why a selfie is required.

Here are the conditions that trigger an anomaly and require a selfie:
1. GPS accuracy is greater than 80 meters (accuracyM > 80).
2. Distance to the nearest work location boundary is less than or equal to 20 meters (distanceToBoundaryM <= 20).
3. The device being used is new or unrecognized (isNewDevice is true).
4. For OFFSITE mode, a selfie is always required regardless of other conditions.

Attendance Details:
- Mode: {{{mode}}}
- GPS Accuracy: {{{accuracyM}}} meters
{{#if distanceToBoundaryM}}
- Distance to {{{workLocationName}}} boundary: {{{distanceToBoundaryM}}} meters
{{/if}}
- New Device: {{{isNewDevice}}}

Combine these reasons into a single, easy-to-understand explanation for "{{{userName}}}".
The required action for any of these conditions is always to take a selfie.

Your response MUST be a JSON object with two fields: "explanation" and "actionRequired". The "actionRequired" field MUST always be "selfie".

Example Output Format:
{
  "explanation": "Hello {{{userName}}}, your GPS accuracy ({{{accuracyM}}}m) is outside the acceptable range. To confirm your current location, a selfie is required for this attendance event.",
  "actionRequired": "selfie"
}

Now, generate the explanation and required action based on the input.`,
});

const explainAttendanceAnomalyFlow = ai.defineFlow(
  {
    name: 'explainAttendanceAnomalyFlow',
    inputSchema: AttendanceAnomalyInputSchema,
    outputSchema: AttendanceAnomalyOutputSchema,
  },
  async (input) => {
    const {output} = await explainAttendanceAnomalyPrompt(input);
    return output!;
  }
);

export async function explainAttendanceAnomaly(input: AttendanceAnomalyInput): Promise<AttendanceAnomalyOutput> {
  return explainAttendanceAnomalyFlow(input);
}
