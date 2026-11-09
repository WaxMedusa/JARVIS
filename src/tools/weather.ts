import {z} from 'zod';
import {fetchCapped} from '../core/http.js';
import {defineTool} from './types.js';

const WEATHER_CODES: Record<number, string> = {
  0: 'clear sky',
  1: 'mainly clear',
  2: 'partly cloudy',
  3: 'overcast',
  45: 'fog',
  48: 'depositing rime fog',
  51: 'light drizzle',
  53: 'moderate drizzle',
  55: 'dense drizzle',
  56: 'light freezing drizzle',
  57: 'dense freezing drizzle',
  61: 'slight rain',
  63: 'moderate rain',
  65: 'heavy rain',
  66: 'light freezing rain',
  67: 'heavy freezing rain',
  71: 'slight snowfall',
  73: 'moderate snowfall',
  75: 'heavy snowfall',
  77: 'snow grains',
  80: 'slight rain showers',
  81: 'moderate rain showers',
  82: 'violent rain showers',
  85: 'slight snow showers',
  86: 'heavy snow showers',
  95: 'thunderstorm',
  96: 'thunderstorm with slight hail',
  99: 'thunderstorm with heavy hail',
};

export const weatherTools = [
  defineTool({
    name: 'get_weather',
    description: 'Get current weather and a daily forecast for a location. Defaults to the user\'s home city from their profile.',
    risk: 'external',
    category: 'weather',
    timeoutMs: 30_000,
    schema: z.object({
      location: z.string().optional().describe('City or place name; defaults to the user profile home_city'),
      days: z.number().int().min(1).max(7).default(3),
      units: z.enum(['metric', 'imperial']).default('metric'),
    }),
    async handler(args, ctx) {
      let location = args.location?.trim() ?? '';
      let fromProfile = false;
      if (!location) {
        const fact = ctx.memory.getProfile({limit: 300}).find((item) =>
          ['home_city', 'location', 'city', 'home_location', 'lives_in'].includes(item.key),
        );
        if (fact) {
          location = fact.value;
          fromProfile = true;
        }
      }
      if (!location) {
        return {content: 'No location given and no home_city in the profile. Ask the user where they are or pass a location.', isError: true};
      }

      const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
      geoUrl.searchParams.set('name', location);
      geoUrl.searchParams.set('count', '1');
      geoUrl.searchParams.set('language', 'en');
      geoUrl.searchParams.set('format', 'json');
      const geo = JSON.parse((await fetchCapped(geoUrl.toString(), {service: 'Open-Meteo geocoding'})).text) as {
        results?: Array<{name: string; latitude: number; longitude: number; country?: string; admin1?: string; timezone?: string}>;
      };
      const place = geo.results?.[0];
      if (!place) return {content: `Could not find a location called "${location}".`, isError: true};

      const forecastUrl = new URL('https://api.open-meteo.com/v1/forecast');
      forecastUrl.searchParams.set('latitude', String(place.latitude));
      forecastUrl.searchParams.set('longitude', String(place.longitude));
      forecastUrl.searchParams.set(
        'current',
        'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m',
      );
      forecastUrl.searchParams.set(
        'daily',
        'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
      );
      forecastUrl.searchParams.set('timezone', 'auto');
      forecastUrl.searchParams.set('forecast_days', String(args.days));
      if (args.units === 'imperial') {
        forecastUrl.searchParams.set('temperature_unit', 'fahrenheit');
        forecastUrl.searchParams.set('wind_speed_unit', 'mph');
        forecastUrl.searchParams.set('precipitation_unit', 'inch');
      }
      const forecast = JSON.parse((await fetchCapped(forecastUrl.toString(), {service: 'Open-Meteo'})).text) as {
        current?: {
          temperature_2m: number;
          apparent_temperature: number;
          relative_humidity_2m: number;
          precipitation: number;
          weather_code: number;
          wind_speed_10m: number;
        };
        daily?: {
          time: string[];
          weather_code: number[];
          temperature_2m_max: number[];
          temperature_2m_min: number[];
          precipitation_probability_max: number[];
          sunrise: string[];
          sunset: string[];
        };
      };
      const unit = args.units === 'imperial' ? '°F' : '°C';
      const speedUnit = args.units === 'imperial' ? 'mph' : 'km/h';
      const current = forecast.current;
      const lines: string[] = [];
      lines.push(`${place.name}${place.admin1 ? `, ${place.admin1}` : ''}${place.country ? `, ${place.country}` : ''}${fromProfile ? ' (home city from profile)' : ''}`);
      if (current) {
        lines.push(
          `Now: ${WEATHER_CODES[current.weather_code] ?? 'unknown'} · ${round(current.temperature_2m)}${unit} (feels ${round(current.apparent_temperature)}${unit}) · humidity ${round(current.relative_humidity_2m)}% · wind ${round(current.wind_speed_10m)} ${speedUnit} · precipitation ${round(current.precipitation)}`,
        );
      }
      for (let i = 0; i < (forecast.daily?.time.length ?? 0); i += 1) {
        const daily = forecast.daily!;
        lines.push(
          `${daily.time[i]}: ${WEATHER_CODES[daily.weather_code[i]!] ?? 'unknown'}, ${round(daily.temperature_2m_min[i]!)}–${round(daily.temperature_2m_max[i]!)}${unit}, precipitation ${daily.precipitation_probability_max[i] ?? 0}%, sunrise ${daily.sunrise[i]?.slice(11)} sunset ${daily.sunset[i]?.slice(11)}`,
        );
      }
      return {content: lines.join('\n'), summary: `${place.name} weather`};
    },
  }),
];

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
