// Fallback city list for the searchable picker when the courier API isn't
// configured (mock mode) or is temporarily unreachable. These ids are synthetic
// and only ever used while booking is in mock mode — a real booking resolves the
// city_id from the courier's own /cities list by name, never from these.
export interface CityOption {
  id: number;
  text: string;
}

export const FALLBACK_CITIES: CityOption[] = [
  "Colombo", "Dehiwala", "Mount Lavinia", "Moratuwa", "Nugegoda", "Maharagama",
  "Kotte", "Rajagiriya", "Battaramulla", "Kaduwela", "Malabe", "Kollupitiya",
  "Wellawatte", "Bambalapitiya", "Homagama", "Piliyandala", "Kesbewa", "Kottawa",
  "Pannipitiya", "Boralesgamuwa", "Kelaniya", "Wattala", "Ja-Ela", "Kandana",
  "Negombo", "Gampaha", "Kadawatha", "Ragama", "Kiribathgoda", "Nittambuwa",
  "Minuwangoda", "Divulapitiya", "Veyangoda", "Kalutara", "Panadura", "Wadduwa",
  "Beruwala", "Aluthgama", "Horana", "Matugama", "Kandy", "Peradeniya",
  "Katugastota", "Gampola", "Nawalapitiya", "Matale", "Dambulla", "Nuwara Eliya",
  "Hatton", "Galle", "Ambalangoda", "Hikkaduwa", "Karapitiya", "Matara",
  "Weligama", "Tangalle", "Hambantota", "Tissamaharama", "Jaffna", "Chavakachcheri",
  "Point Pedro", "Kilinochchi", "Mannar", "Vavuniya", "Mullaitivu", "Batticaloa",
  "Kattankudy", "Eravur", "Ampara", "Kalmunai", "Akkaraipattu", "Trincomalee",
  "Kinniya", "Kurunegala", "Kuliyapitiya", "Pannala", "Wariyapola", "Puttalam",
  "Chilaw", "Wennappuwa", "Anuradhapura", "Kekirawa", "Polonnaruwa", "Badulla",
  "Bandarawela", "Haputale", "Monaragala", "Wellawaya", "Bibile", "Ratnapura",
  "Embilipitiya", "Balangoda", "Kegalle", "Mawanella", "Warakapola",
].map((text, i) => ({ id: -(i + 1), text })); // negative ids: unmistakably not courier ids
